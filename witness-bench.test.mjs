// witness-bench.test.mjs — the bench adapter is regression memory, same as witness itself. The pure
// verdict-assembly is tested exhaustively (the mutation gate rides on these); the IO path is proven
// once, end to end, against the committed adoption fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, specFingerprint, loadBenchConfig, assembleVerdict, assess, headline, mintReceipt, summaryMarkdown, badgeEndpoint, errMsg, parseCli, renderOutput } from './witness-bench.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const CFG = { files: ['a.mjs', 'b.mjs'], testCommand: 'npm test', cap: 80 };
const fixtures = resolve(fileURLToPath(new URL('./fixtures/', import.meta.url)));

// ── canon: the hash is only as reproducible as the stringify ──────────────────
test('canon sorts object keys so insertion order cannot change the hash', () => {
  assert.equal(canon({ b: 1, a: 2 }), canon({ a: 2, b: 1 }));
  assert.notEqual(canon({ a: 1 }), canon({ a: 2 }));
});
test('canon preserves array order (order is meaning) and handles primitives/null', () => {
  assert.notEqual(canon([1, 2]), canon([2, 1]));
  assert.equal(canon(null), 'null');
  assert.equal(canon('x'), '"x"');
  assert.equal(canon(3), '3');
});

// ── specFingerprint: the instrument's identity ────────────────────────────────
test('specFingerprint is a stable 64-hex digest across calls', () => {
  const a = specFingerprint();
  assert.match(a, HEX64);
  assert.equal(a, specFingerprint());
});

// ── assembleVerdict: the pure core the mutation gate verifies ─────────────────
const pf = (file, total, killed, survived, clean, report = {}) => ({ file, total, killed, survived, score: total ? Math.round((killed / total) * 1000) / 1000 : null, clean, report });

test('badge requires at least one file AND every file clean', () => {
  assert.equal(assembleVerdict([], CFG).badge, false);                               // no files is not a pass
  assert.equal(assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG).badge, true);
  assert.equal(assembleVerdict([pf('a.mjs', 4, 4, 0, true), pf('b.mjs', 3, 2, 1, false)], CFG).badge, false); // one dirty denies the badge
});

test('a clean verdict has no tell; totals and score aggregate across files', () => {
  const v = assembleVerdict([pf('a.mjs', 4, 4, 0, true), pf('b.mjs', 6, 6, 0, true)], CFG);
  assert.equal(v.badge, true);
  assert.equal(v.dominantTell, null);
  assert.equal(v.summary.mutants, 10);
  assert.equal(v.summary.killed, 10);
  assert.equal(v.summary.survived, 0);
  assert.equal(v.summary.core, 10);         // proof-of-play figure: killed
  assert.equal(v.summary.nonCore, 0);       // proof-of-play figure: survived
  assert.equal(v.summary.score, 1);
  assert.match(v.hash, HEX64);
});

test('score is null when there are no mutants (an empty run is not a 0 and not a pass)', () => {
  assert.equal(assembleVerdict([], CFG).summary.score, null);           // pins the `mutants > 0` guard
  assert.equal(assembleVerdict([], CFG).summary.mutants, 0);
});

test('dominantTell names the WORST unclean file (lowest score), with the right reason', () => {
  const v = assembleVerdict([
    pf('ok.mjs', 10, 10, 0, true),
    pf('weak.mjs', 10, 8, 2, false),              // score 0.8
    pf('worst.mjs', 10, 3, 7, false),             // score 0.3 — the worst
  ], CFG);
  assert.equal(v.badge, false);
  assert.equal(v.dominantTell.file, 'worst.mjs');
  assert.equal(v.dominantTell.survived, 7);
  assert.equal(v.dominantTell.why, 'surviving mutants (test-theatre)');
});

test('dominantTell distinguishes a red baseline and nothing-to-mutate from theatre', () => {
  assert.equal(assembleVerdict([pf('x.mjs', 0, 0, 0, false, { baselineFailed: true })], CFG).dominantTell.why, 'red baseline');
  assert.equal(assembleVerdict([pf('x.mjs', 0, 0, 0, false, { noMutants: true })], CFG).dominantTell.why, 'nothing to mutate');
});

test('the anchor hash is deterministic and sensitive to the counts it claims', () => {
  const a = assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG);
  const b = assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG);
  assert.equal(a.hash, b.hash);                                                      // same verdict -> same anchor
  const c = assembleVerdict([pf('a.mjs', 4, 3, 1, false)], CFG);
  assert.notEqual(a.hash, c.hash);                                                   // a different claim -> a different anchor
});

test('the anchor binds the instrument fingerprint: it equals the recomputed hash over the public verdict', () => {
  const v = assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG);
  // recompute exactly as assembleVerdict does — proves specFingerprint is inside the hashed object
  const recomputed = canon({ badge: v.badge, spec: v.spec, specFingerprint: v.specFingerprint, summary: { files: v.summary.files, mutants: v.summary.mutants, killed: v.summary.killed, survived: v.summary.survived, score: v.summary.score, clean: v.summary.clean, core: v.summary.core, nonCore: v.summary.nonCore, perFile: v.summary.perFile }, dominantTell: v.dominantTell });
  assert.ok(recomputed.includes(v.specFingerprint));
});

// ── loadBenchConfig: the adoption file ────────────────────────────────────────
function tmpRepo(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'wbench-'));
  if (contents !== undefined) writeFileSync(join(dir, 'witness.bench.json'), contents);
  return dir;
}
test('loadBenchConfig: missing file is refused (no silent default)', () => {
  const dir = tmpRepo(undefined);
  assert.throws(() => loadBenchConfig(dir), /no witness\.bench\.json/);
  rmSync(dir, { recursive: true, force: true });
});
test('loadBenchConfig: a valid file parses and defaults cap/timeout', () => {
  const dir = tmpRepo('{"files":["index.mjs"],"testCommand":"npm test"}');
  const cfg = loadBenchConfig(dir);
  assert.deepEqual(cfg.files, ['index.mjs']);
  assert.equal(cfg.testCommand, 'npm test');
  assert.equal(cfg.cap, 80);
  assert.equal(cfg.timeout, 600000);
  rmSync(dir, { recursive: true, force: true });
});
test('loadBenchConfig: empty files, missing testCommand, and bad JSON are each refused', () => {
  const d1 = tmpRepo('{"files":[],"testCommand":"npm test"}');
  assert.throws(() => loadBenchConfig(d1), /non-empty "files"/);
  const d2 = tmpRepo('{"files":["a.mjs"]}');
  assert.throws(() => loadBenchConfig(d2), /"testCommand"/);
  const d3 = tmpRepo('{ not json ');
  assert.throws(() => loadBenchConfig(d3), /not valid JSON/);
  for (const d of [d1, d2, d3]) rmSync(d, { recursive: true, force: true });
});

// ── mintReceipt: the proof-of-play shape, without re-running ──────────────────
test('mintReceipt shapes the proof-of-play receipt and carries the anchor + admissibility', () => {
  const v = assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG);
  const r = mintReceipt(v, 'myrepo');
  assert.equal(r.repo, 'myrepo');
  assert.equal(r.hash, v.hash);                          // same anchor the gate produced
  assert.equal(r.benchmark.fingerprint, v.specFingerprint);
  assert.equal(r.verdict.badge, true);
  assert.equal(r.verdict.core, 4);                       // killed
  assert.equal(r.admissible, true);
  const dirty = mintReceipt(assembleVerdict([pf('a.mjs', 4, 2, 2, false)], CFG), 'myrepo');
  assert.equal(dirty.admissible, false);                 // survivors deny admission
});

// ── errMsg / parseCli / renderOutput: the CLI seam, pulled out pure to be gate-covered ───────
test('errMsg returns a thrown Error\'s message, and a bare value as itself', () => {
  assert.equal(errMsg(new Error('boom')), 'boom');          // not "Error: boom"
  assert.equal(errMsg('plain'), 'plain');
  assert.equal(errMsg(null), 'null');
});
test('parseCli: subcommand, repo path, and --config are parsed correctly', () => {
  assert.deepEqual(parseCli(['prove', 'myrepo']), { mode: 'prove', repoPath: 'myrepo', configPath: null });
  assert.deepEqual(parseCli(['assess', 'myrepo']), { mode: 'assess', repoPath: 'myrepo', configPath: null });
  // a bare path (no subcommand) defaults to assess and is NOT swallowed as the mode
  assert.deepEqual(parseCli(['somepath']), { mode: 'assess', repoPath: 'somepath', configPath: null });
  assert.equal(parseCli(['prove']).repoPath, '.');          // default path when none given
  assert.equal(parseCli(['.', '--config', 'c.json']).configPath, 'c.json');  // reads the NEXT arg
  assert.equal(parseCli(['.']).configPath, null);           // absent --config -> null
});
test('renderOutput gives a receipt in prove mode and the raw verdict otherwise', () => {
  const v = assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG);
  const proved = JSON.parse(renderOutput(v, 'prove', 'r'));
  assert.equal(proved.admissible, true);                    // receipt shape
  assert.equal(proved.hash, v.hash);
  const raw = JSON.parse(renderOutput(v, 'assess', 'r'));
  assert.ok(raw.summary && raw.summary.perFile);            // verdict shape, not a receipt
  assert.equal(raw.admissible, undefined);
});

// ── headline: the one-line human read ─────────────────────────────────────────
test('headline says teeth / surviving / not-proven for the three shapes', () => {
  assert.match(headline(assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG)), /teeth/);
  assert.match(headline(assembleVerdict([pf('a.mjs', 4, 2, 2, false)], CFG)), /surviving mutant/);
  assert.match(headline(assembleVerdict([pf('a.mjs', 0, 0, 0, false, { noMutants: true })], CFG)), /NOT PROVEN/);
});

// ── the CI surfaces (step summary + badge), pure and gate-covered ─────────────
test('summaryMarkdown shows the per-file table, the anchor, and lists survivors when dirty', () => {
  const clean = summaryMarkdown(assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG), { repo: 'r', sha: 'abcdef1234' });
  assert.match(clean, /✅ witness/);
  assert.match(clean, /\| `a\.mjs` \| 4 \| 4 \| 0 \|/);
  assert.match(clean, /Anchor/);
  assert.doesNotMatch(clean, /Surviving mutants/);
  // an empty repo name falls back to the word "repository" (pins the `repo || 'repository'` default)
  assert.match(summaryMarkdown(assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG), { repo: '' }), /\*\*repository\*\*/);
  // a dirty verdict carries the survivor lines (built from perFileReport)
  const dirtyV = assembleVerdict([{ file: 'b.mjs', total: 4, killed: 2, survived: 2, score: 0.5, clean: false, report: { survivors: [{ line: 3, mutation: '> → >=', snippet: 'n > 0' }] } }], CFG);
  const dirty = summaryMarkdown(dirtyV, { repo: 'r' });
  assert.match(dirty, /❌ witness/);
  assert.match(dirty, /Surviving mutants/);
  assert.match(dirty, /b\.mjs:3/);
});
test('badgeEndpoint is green with teeth, red with survivors, and says not-proven on an empty run', () => {
  assert.deepEqual(badgeEndpoint(assembleVerdict([pf('a.mjs', 4, 4, 0, true)], CFG)), { schemaVersion: 1, label: 'witness', message: 'tests have teeth', color: 'brightgreen' });
  assert.equal(badgeEndpoint(assembleVerdict([pf('a.mjs', 4, 1, 3, false)], CFG)).color, 'red');
  assert.equal(badgeEndpoint(assembleVerdict([pf('a.mjs', 4, 1, 3, false)], CFG)).message, '3 survived');
  assert.equal(badgeEndpoint(assembleVerdict([pf('a.mjs', 0, 0, 0, false, { noMutants: true })], CFG)).message, 'not proven');
});

// ── end-to-end: the real gate on the committed adoption fixture ───────────────
test('assess on the adoption fixture earns the badge and reproduces its anchor', () => {
  const v1 = assess(join(fixtures, 'bench'));
  assert.equal(v1.badge, true, 'the good fixture kills the boundary mutant');
  assert.equal(v1.summary.clean, true);
  // the ACTUAL counts, not just the badge — pins gateFile's `r.total||0` / `r.killed||0` normalization
  assert.equal(v1.summary.mutants, 1, 'boundary.mjs yields exactly one mutant');
  assert.equal(v1.summary.killed, 1, 'the good suite kills it');
  assert.equal(v1.summary.survived, 0);
  assert.match(v1.hash, HEX64);
  const v2 = assess(join(fixtures, 'bench'));
  assert.equal(v2.hash, v1.hash, 'the anchor reproduces on a re-run — this is what makes the receipt re-runnable');
  assert.ok(v1.summary.perFileReport, 'a human report is attached');
});

test('assess catches test-theatre: the weak suite lets the boundary mutant survive', () => {
  const v = assess(fixtures, { config: { files: ['boundary.mjs'], testCommand: 'node --test boundary.theatre.test.mjs', cap: 80, timeout: 120000 } });
  assert.equal(v.badge, false, 'theatre denies the badge');
  assert.equal(v.summary.survived, 1, 'the boundary mutant survives the weak suite');
  assert.equal(v.dominantTell.file, 'boundary.mjs');
  // the survivor DETAIL list is carried, not just the count — pins gateFile's report `r.survived||[]`
  const survs = v.summary.perFileReport.flatMap((f) => f.survivors || []);
  assert.equal(survs.length, 1, 'the surviving mutant is reported with its line');
  assert.ok(survs[0].snippet.includes('n > 0'), 'the survivor names the unguarded line');
});
