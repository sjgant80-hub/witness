#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { mutants, runMutations, fuzz, hostileInputs, OPERATORS, MIN_REASON_CHARS } from './witness.mjs';

const SRC = 'fixtures/boundary.mjs';
const nodeTest = f => ['node', '--test', f];

test('mutants generates one single-point mutation per operator occurrence', () => {
  const ms = mutants('const a = x > 0 && y < 5;');
  // ` > `→` >= `, ` < `→` <= `, ` && `→` || `  = 3 mutants
  assert.equal(ms.length, 3);
  assert.ok(ms.every(m => m.source !== 'const a = x > 0 && y < 5;'), 'each mutant differs from the source');
  assert.ok(ms.every(m => Number.isInteger(m.line) && m.from && m.to));
});

test('the operator set never mis-hits an arrow function or shift', () => {
  // `=>` and `>>>` must not be mutated (no spaced `>` there)
  assert.equal(mutants('const f = () => x;').length, 0);
  assert.equal(mutants('const h = a >>> 16;').length, 0);
});

test('MUTATION GATE catches theatre — a weak suite lets a boundary mutant survive', () => {
  const r = runMutations(SRC, { testCmd: nodeTest('fixtures/boundary.theatre.test.mjs') });
  assert.equal(r.clean, false, 'the weak suite does NOT kill the mutant');
  assert.ok(r.survived.some(s => /> → >=/.test(s.mutation)), 'the surviving mutant is the boundary flip');
});

test('MUTATION GATE passes a real suite — a boundary-testing suite kills the mutant', () => {
  const r = runMutations(SRC, { testCmd: nodeTest('fixtures/boundary.good.test.mjs') });
  assert.equal(r.clean, true, 'the thorough suite kills every mutant');
  assert.equal(r.survived.length, 0);
  assert.equal(r.killed, r.total);
});

test('MUTATION GATE is immune to an inherited node:test context (the leak witness found in itself)', () => {
  // Simulate running under `npm test` where the parent is node:test: NODE_TEST_CONTEXT is set. Without
  // the env scrub the spawned `node --test` exits 0 on failure and every mutant falsely survives.
  const saved = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    const r = runMutations(SRC, { testCmd: nodeTest('fixtures/boundary.good.test.mjs') });
    assert.equal(r.clean, true, 'the child runner still reports the real failure');
    assert.equal(r.killed, r.total);
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('runMutations ALWAYS restores the source file', () => {
  const before = readFileSync(SRC, 'utf8');
  runMutations(SRC, { testCmd: nodeTest('fixtures/boundary.good.test.mjs') });
  assert.equal(readFileSync(SRC, 'utf8'), before, 'the original source is intact after the run');
});

test('runMutations SELF-HEALS a source left mutated by a hard-killed prior run', () => {
  // Simulate the exact corruption a SIGKILL causes: srcPath holds a live mutant and a sidecar backup
  // holds the true original (dropped before the loop). The next run must restore from the backup, not
  // trust the poisoned source — otherwise a crash silently bakes the mutant into the repo.
  const truth = readFileSync(SRC, 'utf8');
  const backup = SRC + '.witnessbak';
  try {
    writeFileSync(SRC, truth.replace(' > ', ' >= '));   // poisoned source (mutant survived the crash)
    writeFileSync(backup, truth);                        // sidecar the killed run left behind
    const r = runMutations(SRC, { testCmd: nodeTest('fixtures/boundary.good.test.mjs') });
    assert.equal(readFileSync(SRC, 'utf8'), truth, 'source healed back to the real original');
    assert.equal(r.clean, true, 'gate ran against the healed source, not the poisoned one');
    assert.ok(!existsSync(backup), 'sidecar cleared after a clean run');
  } finally {
    writeFileSync(SRC, truth);
    if (existsSync(backup)) rmSync(backup);
  }
});

test('TIMEOUT: a mutant that hangs the tests is bounded and counted as killed (baseline still green)', () => {
  // hang.mjs: a `< → <=` mutant makes the binary search non-terminating. The baseline suite PASSES fast, so
  // the gate runs; the hanging mutant times out and is counted KILLED (not left to hang the gate forever).
  const r = runMutations('fixtures/hang.mjs', { testCmd: nodeTest('fixtures/hang.good.test.mjs'), timeout: 1500 });
  assert.equal(r.survived.length, 0, 'the hanging mutant is bounded, not a survivor');
  assert.equal(r.clean, true);
});

test('BASELINE GUARD: a red baseline cannot be reported clean (no false-pass)', () => {
  // If the UNMUTATED suite does not pass, every mutant also "fails" and would be miscounted as killed — the
  // exact bug that let a missing package.json / a broken generated test slip through green. Refuse to gate it.
  const r = runMutations(SRC, { testCmd: ['node', '-e', 'process.exit(1)'], timeout: 1000 });
  assert.equal(r.baselineFailed, true, 'a red baseline is flagged');
  assert.equal(r.clean, false, 'and never reported clean');
});

test('BASELINE: a reviewed-equivalent survivor is ignored, not counted against clean', () => {
  const r = runMutations(SRC, {
    testCmd: nodeTest('fixtures/boundary.theatre.test.mjs'),
    baseline: [{ mutation: '> → >=', snippet: 'export const isPositive = n => n > 0;', reason: 'reviewed — equivalent' }],
  });
  assert.equal(r.survived.length, 0, 'the baselined survivor is no longer an unreviewed survivor');
  assert.equal(r.ignored.length, 1, 'it is recorded as ignored, with its reason');
  assert.equal(r.ignored[0].reason, 'reviewed — equivalent');
  assert.equal(r.clean, true, 'clean = no UNREVIEWED survivors');
});

test('BASELINE cannot hide a real survivor whose code line changed (exact match only)', () => {
  const r = runMutations(SRC, {
    testCmd: nodeTest('fixtures/boundary.theatre.test.mjs'),
    baseline: [{ mutation: '> → >=', snippet: 'const isPositive = n => n > 0; // a DIFFERENT line', reason: 'stale' }],
  });
  assert.equal(r.survived.length, 1, 'a stale baseline entry does not apply — you cannot baseline away a future bug');
  assert.equal(r.ignored.length, 0);
  assert.equal(r.clean, false);
});

test('FUZZ GATE flags a function that throws on hostile input', async () => {
  const risky = x => x.foo.bar;   // throws on null/undefined/etc.
  const r = await fuzz(risky);
  assert.equal(r.neverThrows, false);
  assert.ok(r.throwsOn.length > 0);
});

test('FUZZ GATE passes a guarded never-throw boundary', async () => {
  const safe = x => { try { return x.foo.bar; } catch { return null; } };
  const r = await fuzz(safe);
  assert.equal(r.neverThrows, true, 'a guarded function survives the whole battery');
  assert.deepEqual(r.throwsOn, []);
});

test('FUZZ GATE is async-aware — an async throwing fn is flagged', async () => {
  const r = await fuzz(async x => { if (x == null) throw new Error('boom'); return x; });
  assert.ok(!r.neverThrows);
});

test('the hostile battery includes the classes the audits crashed on', () => {
  const labels = hostileInputs().map(([l]) => l);
  for (const need of ['null', 'BigInt', 'circular object', 'toxic getter', 'huge array']) {
    assert.ok(labels.includes(need), `battery includes ${need}`);
  }
});

test('OPERATORS are all spaced pairs (no arrow/shift false-positives)', () => {
  assert.ok(OPERATORS.length >= 10);
  assert.ok(OPERATORS.every(([f, t]) => typeof f === 'string' && typeof t === 'string' && f !== t));
});

test('⚑ the per-run bound is configurable, because a fixed one silently fakes a clean', () => {
  // A timed-out run counts as KILLED — correct on its own, fatal in aggregate: a suite that is
  // ALWAYS slower than the bound scores 100% having proved nothing, and on Windows each killed
  // subprocess tree orphans, slowing the next run until every run times out. Before this was
  // reachable, witness could not honestly gate any project whose suite took more than 20 seconds.
  const slow = ['node', 'fixtures/slow-suite.mjs'];   // a file, not an inline -e: witness spawns through a shell on Windows

  const tooTight = runMutations(SRC, { cap: 1, testCmd: slow, timeout: 100 });
  assert.equal(tooTight.baselineFailed, true,
    'a bound the suite cannot meet is caught at the baseline, not passed off as a clean sweep');

  const roomy = runMutations(SRC, { cap: 1, testCmd: slow, timeout: 20000 });
  assert.notEqual(roomy.baselineFailed, true, 'and given room, the same suite gates normally');
});

test('the bound defaults to 20s when nothing asks for another', () => {
  const quick = ['node', '--version'];
  const r = runMutations(SRC, { cap: 1, testCmd: quick });
  assert.notEqual(r.baselineFailed, true, 'the default still runs an ordinary suite');
});

test('⚑ a baseline entry with NO reason is refused, and its mutant counts as a survivor', () => {
  // This was the hole: the loader read `e.reason || 'reviewed-equivalent'`, so an entry carrying no
  // reason was admitted AND the sign-off was fabricated. A real surviving mutant — genuine
  // test-theatre, the exact thing this tool exists to catch — went to `ignored`, clean came back
  // true, and the process exited 0. It needed no flag: witness.baseline.json is auto-detected.
  const theatre = 'fixtures/boundary.theatre.test.mjs';
  const naked = runMutations(SRC, { cap: 400, testCmd: nodeTest(theatre), baseline: [
    { mutation: '> → >=', snippet: 'export const isPositive = n => n > 0;' },
  ] });
  assert.equal(naked.clean, false,
    '⚑ an exemption nobody justified must not buy a clean gate');
  assert.ok(naked.survived.length > 0, 'the mutant is reported as the survivor it is');
  assert.equal(naked.ignored.length, 0, 'and it is NOT quietly moved to ignored');
  assert.ok(naked.rejectedExemptions.some(x => /no reason given/.test(x.why)),
    'and the refusal is reported, because a silently dropped exemption looks like one never written');
});

test('a reason too short to argue with is also refused', () => {
  const r = runMutations(SRC, { cap: 400, testCmd: nodeTest('fixtures/boundary.theatre.test.mjs'), baseline: [
    { mutation: '> → >=', snippet: 'export const isPositive = n => n > 0;', reason: 'equivalent' },
  ] });
  assert.equal(r.clean, false, 'ten characters is a shrug, not an excuse');
  assert.ok(r.rejectedExemptions.some(x => /characters/.test(x.why)), 'and it says how short it was');
});

test('a real, argued exemption still works', () => {
  const r = runMutations(SRC, { cap: 400, testCmd: nodeTest('fixtures/boundary.theatre.test.mjs'), baseline: [
    { mutation: '> → >=', snippet: 'export const isPositive = n => n > 0;',
      reason: 'Reviewed: this boundary is unreachable because callers already reject n === 0 upstream, so both forms behave identically.' },
  ] });
  assert.equal(r.ignored.length, 1, 'a sentence somebody could argue with is accepted');
  assert.equal(r.rejectedExemptions.length, 0);
  assert.equal(r.ignored[0].reason.length >= MIN_REASON_CHARS, true, 'and the real reason is carried, not a fabricated one');
});
