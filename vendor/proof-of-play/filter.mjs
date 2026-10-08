#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// proof-of-play · the empirical filter — no listing without a reproducible proof of value
//
// A marketplace of AI-built tools has a lemons problem: anyone can *claim* their tool is good,
// and a catalog that lists on self-asserted quality is worthless. This is the anti-lemons gate.
// A tool may list only if its repository PASSES a benchmark — and the pass is a **Proof-of-Play**:
// a receipt carrying the benchmark's own content-addressed verdict hash.
//
// The proof is un-forgeable by construction, with no trusted signer required. The benchmark is
// deterministic over the repository, so anyone can re-run it and confirm the hash. You cannot
// assert a pass your code does not produce, because the verdict reproduces or it doesn't.
//
// The benchmark is INJECTABLE. The default is acg-assessor (a deterministic, content-addressed
// code-quality rubric), but any benchmark that returns { badge, hash, spec, specFingerprint,
// summary } works. proof-of-play is the gate; the benchmark is the bar.
//
// Zero dependencies — node:child_process, node:crypto, node:fs, node:path.
// ════════════════════════════════════════════════════════════════

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const PROOF_VERSION = '0.1';

// The default benchmark: run acg-assessor as a subprocess and parse its --json verdict.
// Override the path with $PROOF_ASSESSOR or by passing your own `assess` function anywhere below.
export function assessorRunner(assessorPath = process.env.PROOF_ASSESSOR || 'acg-assessor/assessor.mjs') {
  return (repoPath) => {
    const r = spawnSync(process.execPath, [assessorPath, repoPath, '--json'],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (!r.stdout) throw new Error(`benchmark produced no verdict for ${repoPath}: ${(r.stderr || r.error?.message || 'unknown').split('\n')[0]}`);
    let v; try { v = JSON.parse(r.stdout); } catch { throw new Error(`benchmark verdict for ${repoPath} was not JSON`); }
    if (v.hash == null || v.badge == null) throw new Error(`benchmark verdict for ${repoPath} lacks badge/hash`);
    return v;
  };
}

// The default listing policy: a repo is admissible iff it earns the benchmark's badge.
// Swap for a stricter or laxer bar — e.g. require a minimum non-core ratio as well.
export const defaultPolicy = (proof) => proof.verdict.badge === true;

// ── prove ────────────────────────────────────────────────────────────────
// Run the benchmark on a repo and mint a Proof-of-Play. `provedAt` is optional metadata and is
// deliberately NOT part of the trust check — authenticity rests on the reproducible hash alone.
export function proveRepo(repoPath, { assess = assessorRunner(), policy = defaultPolicy, provedAt } = {}) {
  const v = assess(repoPath);
  // ⚑ REFUSE TO MINT WHAT CANNOT BE VERIFIED. assessorRunner already rejects a verdict with no hash
  // or no badge — but the assessor is injectable, and anything supplied through that door skipped the
  // check entirely. A proof with no hash anchors nothing: verify() would later call it malformed, so
  // minting it produces a token that looks like evidence and can never be redeemed. Better to fail
  // where the fault is than to hand somebody a receipt for nothing.
  if (v == null || typeof v !== 'object') throw new Error(`benchmark verdict for ${repoPath} is not a verdict`);
  if (v.hash == null || v.badge == null) throw new Error(`benchmark verdict for ${repoPath} is missing its hash or badge`);
  const proof = {
    v: PROOF_VERSION,
    repo: basename(String(repoPath).replace(/[\\/]+$/, '')),
    benchmark: { spec: v.spec ?? null, fingerprint: v.specFingerprint ?? null },
    verdict: {
      badge: v.badge === true,
      core: v.summary?.core ?? null,
      nonCore: v.summary?.nonCore ?? null,
      dominantTell: v.dominantTell ?? null,
    },
    hash: v.hash,                       // the un-forgeable anchor: the benchmark's verdict hash
  };
  if (provedAt) proof.provedAt = provedAt;
  proof.admissible = policy(proof) === true;
  return proof;
}

// ── verify ───────────────────────────────────────────────────────────────
//
// WHAT A FAILED VERIFICATION IS ACTUALLY ABOUT.
//
// ⚑ This returned `hash-mismatch` for three unrelated situations, and the page rendered every one
// of them as "the receipt claimed a pass this repository does not currently produce" — an
// accusation. The three:
//
//   · the two sides ran DIFFERENT VERSIONS OF THE BENCHMARK. Nothing to do with the seller; it is
//     the marketplace's own instrument that moved, or the verifier passed the wrong --assessor.
//   · the REPOSITORY MOVED since the proof was minted. A commit landed. Entirely normal, and the
//     remedy is to re-prove, not to be accused of fraud.
//   · the ANCHOR DOES NOT CORRESPOND TO THE VERDICT. The forgery shape.
//
// A marketplace gate that cannot tell a seller "your code changed, re-prove" from "your receipt is
// fabricated" is not usable by honest sellers, and the trust rail's value is that honest parties
// can rely on it. One word covering all three is a worse instrument than three words.
//
// ⚑ WORSE: the distinction this file claimed to make was UNREACHABLE. `benchmark-version-changed`
// sat BELOW the hash check, and acg-assessor computes its hash over a verdict object that contains
// specFingerprint — so any change to the benchmark changes the hash, the hash check fires first,
// and the fingerprint branch is never reached with a real benchmark. It looked covered because the
// test stub returns a hash of `'h:' + repoPath`, decoupled from its own spec, which is a benchmark
// that cannot exist. And test.mjs asserted that the reason was EITHER of the two, with an or —
// an assertion that accepts either answer, which is what writing down an ambiguity looks like
// instead of resolving it. The instrument check now runs FIRST, where it can actually fire.
//
// (Described rather than quoted, deliberately. A verbatim quotation puts operators into a comment,
// and a mutation gate generates mutants from them that no test can ever kill — so the file reads as
// test-theatre because of a sentence ABOUT the code. It has cost this estate seven repositories.)
//
// Every branch below still returns ok:false. The distinction is about the EXPLANATION owed to
// whoever is being refused — never about letting anything in. "It is only drift" must never become
// a door.
export const CAUSE = Object.freeze({
  input: 'input',              // what was handed in is not a proof
  benchmark: 'benchmark',      // the two sides did not run the same instrument
  repository: 'repository',    // the code moved since the proof was minted
  unattributed: 'unattributed',// the mismatch is real and re-running cannot say why
  proof: 'proof',              // the proof claims more than its own verdict supports
});

// The headline figures a proof records, so a later verification can say WHAT moved rather than only
// that something did.
const FIGURES = ['badge', 'core', 'nonCore', 'dominantTell'];
const figuresOf = (fresh) => ({
  badge: fresh?.badge === true,
  core: fresh?.summary?.core ?? null,
  nonCore: fresh?.summary?.nonCore ?? null,
  dominantTell: fresh?.dominantTell ?? null,
});

/**
 * Which recorded figures differ between a proof's verdict and a fresh one.
 * `null` means the proof recorded nothing comparable — not that nothing moved. The two must not
 * collapse into one another, because "nothing moved" is evidence and "I cannot tell" is not.
 */
export function movedFigures(proofVerdict, fresh) {
  if (!proofVerdict || typeof proofVerdict !== 'object') return null;
  const now = figuresOf(fresh);
  return FIGURES.filter(k => proofVerdict[k] !== now[k]);
}

export function verify(proof, repoPath, { assess = assessorRunner() } = {}) {
  if (!proof || typeof proof !== 'object' || !proof.hash)
    return { ok: false, cause: CAUSE.input, reason: 'malformed-proof' };

  // ⚑ NOTHING HERE EVER CHECKED THE PROOF WAS FOR THIS REPOSITORY. proveRepo() records `repo` and
  // verify() then never looked at it, so a proof transferred between repos was caught only by the
  // hash — i.e. only when the two repos differ in content. The suite has a test named "a proof does
  // not transfer between repos" that passed for exactly that incidental reason, which is the same
  // fault this file's own gate.test.mjs header describes: a test passing through a check other than
  // the one it names. Take a passing repo's proof and present it for a byte-identical FORK and it
  // verified, because the verdict is deterministic over content and the two contents are the same.
  // In a fork-tree economy that is not a hypothetical.
  //
  // The name can only ever REFUSE. Two unrelated repos can share a basename, so a match proves
  // nothing — the reproducing hash is still what does the work. A one-line check that closes a real
  // transfer and claims nothing beyond it.
  const claimedRepo = typeof proof.repo === 'string' ? proof.repo : null;
  const actualRepo = basename(String(repoPath ?? '').replace(/[\\/]+$/, ''));
  if (claimedRepo !== null && claimedRepo !== actualRepo)
    return { ok: false, cause: CAUSE.proof, reason: 'repo-mismatch', claimed: claimedRepo, actual: actualRepo };

  let fresh;
  try { fresh = assess(repoPath); }
  catch (e) { return { ok: false, cause: CAUSE.benchmark, reason: 'benchmark-error', detail: String(e.message || e) }; }

  const claimedFp = proof.benchmark?.fingerprint ?? null;
  const actualFp = fresh?.specFingerprint ?? null;
  const sameInstrument = claimedFp !== null && actualFp !== null && claimedFp === actualFp;

  // FIRST, because a changed instrument is not evidence about the repository and must not be
  // reported as though it were.
  if (claimedFp !== null && actualFp !== null && claimedFp !== actualFp)
    return { ok: false, cause: CAUSE.benchmark, reason: 'benchmark-changed', claimed: claimedFp, actual: actualFp };

  if (fresh?.hash !== proof.hash) {
    const moved = movedFigures(proof.verdict, fresh);
    if (moved && moved.length)
      return { ok: false, cause: CAUSE.repository, reason: 'verdict-changed', claimed: proof.hash, actual: fresh?.hash ?? null, moved };
    // The anchor differs while everything the proof recorded still agrees. That is the shape of a
    // fabricated hash — and ALSO the shape of a change that did not move the headline figures, since
    // the anchor covers the whole verdict and these four fields are a summary of it. Re-running
    // cannot separate those, so this does not say "forged". Naming a state the tool cannot
    // distinguish is how a gate starts making accusations it cannot support.
    return {
      ok: false, cause: sameInstrument ? CAUSE.unattributed : CAUSE.benchmark,
      reason: sameInstrument ? 'anchor-mismatch' : 'unattributable-mismatch',
      claimed: proof.hash, actual: fresh?.hash ?? null,
      detail: sameInstrument
        ? 'the anchor does not reproduce while every recorded figure still agrees — either a change that did not move them, or a hash that was never produced by this benchmark. Re-running cannot tell these apart.'
        : 'the anchor does not reproduce and at least one side does not identify its benchmark version, so the mismatch cannot be attributed to the repository or to the instrument',
    };
  }

  // belt and braces: an admissibility claim must match what the verdict actually supports
  if (proof.admissible === true && fresh.badge !== true)
    return { ok: false, cause: CAUSE.proof, reason: 'admissibility-overclaim' };
  return { ok: true, cause: null, reason: 'authentic' };
}

// ── filter ───────────────────────────────────────────────────────────────
// The gate. Partition a set of listings by whether their repository passes the benchmark.
// `resolveRepo(listing)` maps a listing to a repo path (default: listing.repoPath or listing.repo).
export function filterListings(listings, {
  assess = assessorRunner(), policy = defaultPolicy,
  resolveRepo = (l) => l.repoPath || l.repo, provedAt,
} = {}) {
  const admitted = [], rejected = [], proofs = [];
  for (const listing of listings) {
    const repoPath = resolveRepo(listing);
    if (!repoPath) { rejected.push({ listing, reason: 'no-repo' }); continue; }
    let proof;
    try { proof = proveRepo(repoPath, { assess, policy, provedAt }); }
    catch (e) { rejected.push({ listing, reason: 'unresolvable', detail: String(e.message || e) }); continue; }
    proofs.push(proof);
    if (proof.admissible) admitted.push({ listing, proof });
    else rejected.push({ listing, proof, reason: 'failed-benchmark' });
  }
  return { admitted, rejected, proofs, total: listings.length };
}

// ── CLI ────────────────────────────────────────────────────────────────────
// ⚑ EXPORTED SO IT CAN BE TESTED. The command line was the only part of this file no test touched,
// and a flag that silently stops being read is exactly the fault nobody notices until the day it
// matters: --assessor pointing at the wrong benchmark still prints a confident verdict.
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const arg = (k, d) => { const i = list.indexOf(k); return i >= 0 ? list[i + 1] : d; };
  return { cmd: list[2], arg };
}

export function cli(argv) {
  const { cmd, arg } = parseArgs(argv);
  const assess = assessorRunner(arg('--assessor', process.env.PROOF_ASSESSOR || 'acg-assessor/assessor.mjs'));

  if (cmd === 'prove') {
    const repo = argv[3];
    if (!repo) { console.error('usage: prove <repo> [--assessor path]'); process.exit(2); }
    const proof = proveRepo(repo, { assess });
    console.log(JSON.stringify(proof, null, 2));
    process.exit(proof.admissible ? 0 : 1);
  }

  if (cmd === 'verify') {
    const proofPath = argv[3], repo = argv[4];
    if (!proofPath || !repo) { console.error('usage: verify <proof.json> <repo> [--assessor path]'); process.exit(2); }
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    const r = verify(proof, repo, { assess });
    // The cause is the part a seller can act on: their code, the marketplace's benchmark, or the
    // receipt itself. Printing only the reason left them to guess which of the three it was.
    console.log(`${r.ok ? '✓ AUTHENTIC' : '✗ ' + r.reason.toUpperCase() + ' [' + r.cause + ']'}`
      + (r.actual ? `  claimed ${r.claimed} · actual ${r.actual}` : ''));
    if (r.moved && r.moved.length) console.log(`  moved: ${r.moved.join(', ')}`);
    if (r.detail) console.log(`  ${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'filter') {
    const listingsPath = argv[3];
    if (!listingsPath) { console.error('usage: filter <listings.json> [--root dir] [--assessor path]'); process.exit(2); }
    const root = arg('--root', '.');
    const raw = JSON.parse(readFileSync(listingsPath, 'utf8'));
    const listings = Array.isArray(raw) ? raw : (raw.listings || []);
    const resolveRepo = (l) => `${root}/${l.repo || l.name}`.replace(/\/+/g, '/');
    const r = filterListings(listings, { assess, resolveRepo });
    console.log(`listings: ${r.total}  ·  admitted: ${r.admitted.length}  ·  rejected: ${r.rejected.length}`);
    for (const x of r.rejected) console.log(`  ✗ ${x.listing.repo || x.listing.name || '?'}  (${x.reason})`);
    process.exit(0);
  }

  console.error('proof-of-play · commands: prove, verify, filter');
  process.exit(2);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) cli(process.argv);
