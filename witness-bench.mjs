// ════════════════════════════════════════════════════════════════
// witness-bench · witness AS a proof-of-play benchmark — the bind that lands the rail in a CI
//
// witness answers one question deterministically: do this repo's own tests have TEETH — can they
// tell the code from a one-operator mutation of it, or are they theatre? proof-of-play turns any
// deterministic, content-addressed benchmark into an UN-FORGEABLE, re-runnable receipt: a pass you
// cannot assert without the code that produces it, because verification just re-runs the benchmark
// and checks the hash. This file is the adapter that makes the first feed the second.
//
// An external team adopts the rail with ONE file in their repo — `witness.bench.json` naming which
// sources to gate and the test command — and ONE CI step. The step mints a receipt whose badge means
// "these tests kill mutants", anchored by a hash anyone can reproduce. Paste a passing hash onto a
// repo whose tests are theatre and `verify` re-derives the real one: refused. That is the whole moat,
// mutation proof + third-party re-run, in a drop-in.
//
// The verdict shape is exactly proof-of-play's contract: { badge, hash, spec, specFingerprint,
// summary, dominantTell }. `specFingerprint` fingerprints the INSTRUMENT (witness's own source + its
// operator set), so a gate that changed under you changes the fingerprint and `verify` says so rather
// than blaming the repo. The hash covers the whole verdict INCLUDING that fingerprint, so a changed
// gate also changes the anchor. Deterministic: no Math.random, no Date.now in anything hashed (the
// baseline timing runMutations measures is never part of the verdict).
//
// Zero dependencies — node:crypto/fs/path + witness.mjs. Runs anywhere Node runs.
// ════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runMutations, OPERATORS, MIN_REASON_CHARS } from './witness.mjs';

export const BENCH_VERSION = '1';

const here = dirname(fileURLToPath(import.meta.url));

// ── canonical JSON: sorted object keys, arrays in order — so the same verdict hashes the same byte
// string on every machine. Numbers/strings/bools/null pass through; objects are key-sorted recursively.
export function canon(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  const keys = Object.keys(x).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

// a thrown value's message, or the value itself when it has none — so error strings are deterministic
// (and the mutation gate can pin them) instead of printing "[object Object]" or a whole Error.
export function errMsg(e) { return String(e && e.message || e); }

// ── the instrument's identity: witness's own source + its operator set + the exemption bar. Change
// any of these and the fingerprint changes, so a proof minted under one gate cannot silently be
// verified under another — `verify` reports benchmark-changed, not a repository fault. Pins "the gate
// you reviewed is the gate that runs" into the receipt itself.
// Normalise line endings before fingerprinting the source. Git checks the same blob out as CRLF on a
// Windows working copy and LF on a Linux runner; without this the fingerprint — and so the whole
// anchor — would differ by platform, and the receipt would NOT reproduce across machines, which is the
// one thing it promises. (The estate's CRLF trap, designed out here.)
const lf = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export function specFingerprint() {
  let witnessSrc = '';
  try { witnessSrc = readFileSync(join(here, 'witness.mjs'), 'utf8'); } catch { /* fingerprint still covers the rest */ }
  return sha(canon({
    instrument: 'witness',
    benchVersion: BENCH_VERSION,
    witnessSourceSha: sha(lf(witnessSrc)),
    operators: OPERATORS,
    minReasonChars: MIN_REASON_CHARS,
  }));
}

// ── the adoption file: a repo declares what to gate. { files:[...], testCommand, cap?, timeout? }.
// Kept deliberately small — the config travels WITH the code, so anyone who clones the repo can
// reproduce the same verdict with no out-of-band knowledge. That is what makes the proof re-runnable.
export function loadBenchConfig(repoPath) {
  const p = join(repoPath, 'witness.bench.json');
  if (!existsSync(p)) throw new Error(`no witness.bench.json in ${repoPath} — a repo adopts the rail by declaring { "files": [...], "testCommand": "..." }`);
  let cfg; try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`witness.bench.json in ${repoPath} is not valid JSON: ${errMsg(e)}`); }
  if (!Array.isArray(cfg.files) || cfg.files.length === 0) throw new Error('witness.bench.json needs a non-empty "files" array');
  if (typeof cfg.testCommand !== 'string' || !cfg.testCommand.trim()) throw new Error('witness.bench.json needs a "testCommand" string (must exit non-zero when a test fails)');
  return {
    files: cfg.files.map(String),
    testCommand: cfg.testCommand.trim(),
    cap: Number.isFinite(cfg.cap) ? cfg.cap : 80,
    // Default generously: the external suite runs once per mutant, so the bound must clear a slow
    // suite. runMutations refuses a bound that is not 2x the measured baseline, so this is a ceiling,
    // not a wall every mutant hits.
    timeout: Number.isFinite(cfg.timeout) ? cfg.timeout : 600000,
  };
}

// ── run witness over one declared file, normalising the result to a per-file record. Separated from
// verdict assembly so the IO (subprocesses) and the arithmetic can be tested apart.
export function gateFile(root, file, cfg) {
  const srcPath = resolve(root, file);
  const testCmd = cfg.testCommand.split(/\s+/);
  let r;
  try { r = runMutations(srcPath, { cwd: root, testCmd, cap: cfg.cap, timeout: cfg.timeout }); }
  catch (e) { r = { total: 0, killed: 0, survived: [], score: null, clean: false, benchError: errMsg(e) }; }
  return {
    file,
    total: r.total || 0,
    killed: r.killed || 0,
    survived: (r.survived || []).length,
    score: r.score ?? null,
    clean: r.clean === true,
    // human-facing only; NOT part of the hashed verdict
    report: {
      survivors: (r.survived || []).map((s) => ({ line: s.line, mutation: s.mutation, snippet: s.snippet })),
      ...(r.noMutants ? { noMutants: true, reason: r.reason } : {}),
      ...(r.baselineFailed ? { baselineFailed: true, reason: r.reason } : {}),
      ...(r.benchError ? { benchError: r.benchError } : {}),
    },
  };
}

// ── PURE: assemble the proof-of-play verdict from per-file records. No IO, no clock — deterministic,
// so the same per-file counts always produce the same anchor hash. This is the part the mutation gate
// can verify exhaustively (badge logic, totals, score, the worst-file tell, the hash coverage).
export function assembleVerdict(perFile, cfg) {
  const mutants = perFile.reduce((a, f) => a + f.total, 0);
  const killed = perFile.reduce((a, f) => a + f.killed, 0);
  const survived = perFile.reduce((a, f) => a + f.survived, 0);
  // BADGE = every declared file produced mutants AND the suite killed all of them. A file with nothing
  // to mutate, a red baseline, or any survivor denies the badge — the same "an empty run is not a pass"
  // rule witness itself enforces, lifted to the whole repo.
  const badge = perFile.length > 0 && perFile.every((f) => f.clean === true);
  const score = mutants > 0 ? Math.round((killed / mutants) * 1000) / 1000 : null;

  // when it is NOT clean, the single thing a reviewer wants: the worst file and why.
  const worst = perFile.filter((f) => !f.clean).sort((a, b) => (a.score ?? -1) - (b.score ?? -1))[0];
  const dominantTell = badge ? null : (worst ? {
    file: worst.file, survived: worst.survived, score: worst.score,
    why: worst.report && worst.report.baselineFailed ? 'red baseline'
      : worst.report && worst.report.noMutants ? 'nothing to mutate'
      : 'surviving mutants (test-theatre)',
  } : null);

  const spec = { benchmark: 'witness', benchVersion: BENCH_VERSION, files: cfg.files, testCommand: cfg.testCommand, cap: cfg.cap, operators: OPERATORS.length };
  const fp = specFingerprint();

  // summary carries proof-of-play's recorded figures (core/nonCore) so a later verify can say WHAT
  // moved: core = mutants killed, nonCore = mutants survived.
  const summaryHashed = {
    files: perFile.length, mutants, killed, survived, score, clean: badge,
    core: killed, nonCore: survived,
    perFile: perFile.map((f) => ({ file: f.file, total: f.total, killed: f.killed, survived: f.survived, score: f.score, clean: f.clean })),
  };

  // the anchor: hash the whole verdict EXCEPT the human-only report and the hash field itself. No
  // timing, no snippets — the claim is "badge + these counts under this instrument", nothing cosmetic.
  const hash = sha(canon({ badge, spec, specFingerprint: fp, summary: summaryHashed, dominantTell }));

  return {
    badge, hash, spec, specFingerprint: fp, dominantTell,
    summary: { ...summaryHashed, perFileReport: perFile.map((f) => ({ file: f.file, ...f.report })) },
  };
}

// ── run the gate over a repo and emit the proof-of-play verdict. Deterministic over (repo source +
// repo tests + witness). The returned object is what proof-of-play's assessorRunner expects on stdout.
export function assess(repoPath, { config } = {}) {
  const root = resolve(repoPath);
  const cfg = config || loadBenchConfig(root);
  const perFile = cfg.files.map((file) => gateFile(root, file, cfg));
  return assembleVerdict(perFile, cfg);
}

// ── mint a proof-of-play receipt from a verdict, WITHOUT re-running the gate. Shaped byte-for-byte
// like proof-of-play's own proveRepo output, so the vendored `verify` (which re-runs the benchmark
// and checks the hash) accepts a receipt minted here. One gate run in CI, not two — the external
// suite can be slow, and running it twice to mint-then-gate would be the wasteful path.
export const PROOF_VERSION = '0.1';
export function mintReceipt(v, repoName) {
  return {
    v: PROOF_VERSION,
    repo: repoName,
    benchmark: { spec: v.spec ?? null, fingerprint: v.specFingerprint ?? null },
    verdict: { badge: v.badge === true, core: v.summary?.core ?? null, nonCore: v.summary?.nonCore ?? null, dominantTell: v.dominantTell ?? null },
    hash: v.hash,
    admissible: v.badge === true,
  };
}

// a one-line human headline for a step summary / badge text
export function headline(v) {
  if (v.badge) return `witness: tests have teeth — ${v.summary.killed}/${v.summary.mutants} mutants killed across ${v.summary.files} file(s), 0 survived`;
  const s = v.summary;
  if (s.mutants === 0) return `witness: NOT PROVEN — no mutants generated (check files / operators)`;
  return `witness: ${s.survived} surviving mutant(s) — test-theatre in ${v.dominantTell ? v.dominantTell.file : 'the gated set'}`;
}

// ── PURE: the GitHub step-summary markdown a reviewer reads on the Actions run. A per-file table,
// the anchor, and — when it is NOT clean — the exact surviving mutants (the lines that are theatre).
export function summaryMarkdown(v, { repo = '', sha = '' } = {}) {
  const s = v.summary;
  const mark = v.badge ? '✅' : '❌';
  const rows = (s.perFile || []).map((f) => `| \`${f.file}\` | ${f.total} | ${f.killed} | ${f.survived} | ${f.score ?? '—'} | ${f.clean ? '✅ teeth' : '❌ theatre'} |`).join('\n');
  let md = `## ${mark} witness — proof of play\n\n`;
  md += `**${repo || 'repository'}**${sha ? ` @ \`${String(sha).slice(0, 7)}\`` : ''} — ${headline(v)}\n\n`;
  md += `| file | mutants | killed | survived | score | verdict |\n|---|--:|--:|--:|--:|:--|\n${rows}\n\n`;
  const survivors = (s.perFileReport || []).flatMap((f) => (f.survivors || []).map((x) => ({ file: f.file, ...x })));
  if (survivors.length) {
    md += `**Surviving mutants (test-theatre):**\n\n`;
    md += survivors.slice(0, 50).map((x) => `- \`${x.file}:${x.line}\` — ${x.mutation} — \`${x.snippet}\``).join('\n') + '\n\n';
  }
  md += `**Anchor** \`${v.hash}\`\n`;
  md += `_Re-runnable receipt: this verdict reproduces on any clean runner. A pasted hash that the code does not produce is refused._\n`;
  return md;
}

// ── PURE: a shields.io "endpoint" badge object. Publish it and point a badge at it; green = teeth.
export function badgeEndpoint(v) {
  return {
    schemaVersion: 1,
    label: 'witness',
    message: v.badge ? 'tests have teeth' : (v.summary.mutants === 0 ? 'not proven' : `${v.summary.survived} survived`),
    color: v.badge ? 'brightgreen' : 'red',
  };
}

// ── CLI: `node witness-bench.mjs [prove|assess] <repoPath> [--config <file>]`
// `prove` mints the proof-of-play receipt; the default prints the verdict (what proof-of-play's
// assessorRunner reads from stdout). Exits 0 iff the badge is earned, so it is also a bare CI gate.
// The parsing and the shaping are pulled out PURE so the mutation gate can verify them without a CLI.
export function parseCli(argv) {
  const args = argv.slice();
  // optional leading subcommand; anything else is treated as the repo path.
  const mode = (args[0] === 'prove' || args[0] === 'assess') ? args.shift() : 'assess';
  const repoPath = args.find((a) => !a.startsWith('--')) || '.';
  const cfgIdx = args.indexOf('--config');
  const configPath = cfgIdx !== -1 ? args[cfgIdx + 1] : null;
  return { mode, repoPath, configPath };
}

// what to print for a verdict: the receipt in `prove` mode, the raw verdict otherwise.
export function renderOutput(v, mode, repoName) {
  return mode === 'prove' ? JSON.stringify(mintReceipt(v, repoName), null, 2) : JSON.stringify(v, null, 2);
}

async function main() {
  const { mode, repoPath, configPath } = parseCli(process.argv.slice(2));
  const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
  let v;
  try { v = assess(repoPath, { config }); }
  catch (e) { console.error(`witness-bench: ${errMsg(e)}`); process.exit(2); }
  console.log(renderOutput(v, mode, basename(resolve(repoPath).replace(/[\\/]+$/, ''))));
  console.error('\n' + headline(v));
  process.exit(v.badge ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export default { assess, assembleVerdict, gateFile, canon, specFingerprint, loadBenchConfig, mintReceipt, headline, summaryMarkdown, badgeEndpoint, errMsg, parseCli, renderOutput, BENCH_VERSION, PROOF_VERSION };
