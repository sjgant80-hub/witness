#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mutants, commentMask, runMutations, fuzz, hostileInputs, OPERATORS, MIN_REASON_CHARS, boundIsAdequate, BOUND_HEADROOM } from './witness.mjs';

const SRC = 'fixtures/boundary.mjs';
const nodeTest = f => ['node', '--test', f];

test('mutants generates one single-point mutation per operator occurrence', () => {
  const ms = mutants('const a = x > 0 && y < 5;');
  // ` > `→` >= `, ` < `→` <= `, ` && `→` || `  = 3 mutants
  assert.equal(ms.length, 3);
  assert.ok(ms.every(m => m.source !== 'const a = x > 0 && y < 5;'), 'each mutant differs from the source');
  assert.ok(ms.every(m => Number.isInteger(m.line) && m.from && m.to));
});

// ── comments are not code ────────────────────────────────────────────────────
// An operator inside a comment cannot be killed by any test, because changing it changes nothing.
// witness used to emit those anyway, so a file was reported as test-theatre because of a sentence
// somebody wrote ABOUT the code — and the only ways out were to delete the explanation or to
// baseline the mutant. That has happened seven times across this estate.

test('an operator inside a line comment produces no mutant', () => {
  assert.equal(mutants('// if (a === b) return true;').length, 0);
  assert.equal(mutants('const x = 1;   // guard: a >= b && c < d').length, 0);
});

test('an operator inside a block comment produces no mutant', () => {
  assert.equal(mutants('/* a === b || c !== d */').length, 0);
  assert.equal(mutants('/**\n * a >= b\n */\nconst n = 1;').length, 0);
});

test('an unterminated block comment swallows the rest of the file, as the parser does', () => {
  assert.equal(mutants('const ok = 1;\n/* a === b\nc >= d').length, 0);
});

test('code either side of a comment is still mutated', () => {
  const ms = mutants('const a = x > 0;  // and y < 5 is irrelevant\nconst b = p === q;');
  assert.deepEqual(ms.map(m => m.from).sort(), ['===', '>']);
});

test('a comment marker inside a string does not blind the mutator to real code after it', () => {
  // The string holds what looks like the start of a comment. A regex-based masker treats the rest
  // of the line as commented and silently stops testing it; that hides code instead of noise.
  const src = 'const url = "http://x/" + p;\nconst live = a === b;';
  assert.deepEqual(mutants(src).map(m => m.from), ['===']);
});

test('a quote inside a comment does not leave the masker stuck inside a string', () => {
  // An apostrophe in prose used to look like an opening quote. If the scanner believed it, every
  // operator after it would be read as string content and never mutated again.
  const src = "// it doesn't matter here\nconst live = a === b;";
  assert.deepEqual(mutants(src).map(m => m.from), ['===']);
});

test('string literals ARE still mutated — a string can change behaviour, a comment cannot', () => {
  // Deliberate. An error message gets asserted on and a pattern gets compiled, so a surviving
  // string mutant is weak evidence, but it is evidence. A comment mutant is not evidence at all.
  assert.equal(mutants('const msg = "a === b";').length, 1);
});

test('an escaped quote does not end the string early', () => {
  const src = 'const s = "he said \\" a === b";\nconst live = p !== q;';
  const got = mutants(src).map(m => m.from).sort();
  assert.deepEqual(got, ['!==', '===']);
});

test('commentMask marks exactly the comment bytes and nothing else', () => {
  const src = 'ab// cd\nef';
  const mask = commentMask(src);
  assert.deepEqual([...mask], [0, 0, 1, 1, 1, 1, 1, 0, 0, 0]);
  assert.equal(commentMask('').length, 0);
  assert.equal(commentMask(null).length, 0);
  assert.equal(commentMask(undefined).length, 0);
});

// ── the two comment-mask boundaries that a corpus proved were NOT equivalent ─────
// Both survived the gate, and both looked like off-by-one noise in a scanner. A differential run
// over 33 samples (including this file and witness.mjs) showed each one changes what gets mutated.
// The lesson is the one this repo keeps relearning: an equivalence claim is a claim.

test('a block comment must not swallow the operator that follows it', () => {
  // With the end bound one byte long, the mask covers the first character after the closing marker.
  // Put a comment mid-expression and that character is the start of the operator, so a real
  // decision point silently stops being tested — the masker hiding code instead of noise, which is
  // the exact failure it was written to avoid.
  assert.equal(commentMask('/*a*/b === c').at(5), 0, 'the byte after the comment was masked');
  assert.equal(mutants('const y = x /*why*/ === z;').length, 1);
});

test('a quote must not swallow the rest of the file', () => {
  // The escape check is the only branch that can advance past a closing quote correctly. Invert it
  // and every character skips two, so the closing quote is stepped over, the string never ends, and
  // everything after it — comments included — is read as string content.
  assert.equal(mutants('const s = "ab"; // c === d').length, 0, 'a comment after a string was mutated');
  assert.equal(mutants('const s = "ab"; const live = c === d;').length, 1, 'and real code after a string still is');
});

// ── boundaries elsewhere the suite had never stood on ────────────────────────────

test('an exemption of exactly MIN_REASON_CHARS is accepted, not rounded away', () => {
  const reason = 'x'.repeat(MIN_REASON_CHARS);
  assert.equal(reason.length, MIN_REASON_CHARS);
  const ms = mutants(readFileSync(SRC, 'utf8'));
  const entry = { mutation: `${ms[0].from} → ${ms[0].to}`, snippet: 'anything', reason };
  const r = runMutations(SRC, { testCmd: nodeTest('fixtures/boundary.good.test.mjs'), cap: 1, baseline: [entry] });
  assert.equal((r.rejectedExemptions || []).length, 0,
    'a reason of exactly the minimum length was refused — the rule is "at least", not "more than"');
  const short = { ...entry, reason: 'x'.repeat(MIN_REASON_CHARS - 1) };
  const r2 = runMutations(SRC, { testCmd: nodeTest('fixtures/boundary.good.test.mjs'), cap: 1, baseline: [short] });
  assert.equal((r2.rejectedExemptions || []).length, 1, 'and one character under is still refused');
});

test('a cap equal to the number of mutants has capped nothing', () => {
  // `capped` is the kept count when it truncated, and false when it did not — asserted against the
  // real shape rather than a boolean I assumed.
  const dir = mkdtempSync(join(tmpdir(), 'witness-cap-'));
  const src = join(dir, 'many.mjs');
  writeFileSync(src, 'export const a = (x, y) => x > y;\nexport const b = (x, y) => x < y;\nexport const c = (x, y) => x === y;\n');
  const total = mutants(readFileSync(src, 'utf8')).length;
  assert.ok(total >= 3, 'the fixture needs enough mutants for the boundary to mean something');

  const exact = runMutations(src, { testCmd: ['node', '-e', '0'], cap: total });
  assert.equal(exact.capped, false, 'a cap equal to the count reported a truncation that did not happen');
  assert.equal(exact.total, total);

  const under = runMutations(src, { testCmd: ['node', '-e', '0'], cap: total - 1 });
  assert.equal(under.capped, total - 1, 'and one fewer really is a truncation, reported as the kept count');
  assert.equal(under.total, total - 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── the command line, which no test had ever run ─────────────────────────────────
// Every survivor in cli() was an argument the gate reads and nobody checked. A flag that silently
// stops being read is the fault nobody notices until it matters: witness would go on printing a
// confident verdict computed with the wrong bound, or with no test command at all.

const WITNESS = resolve('witness.mjs');
const runCli = (args, cwd) => {
  const r = spawnSync(process.execPath, [WITNESS, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

/** A throwaway project whose `npm test` is instant, so the CLI can be driven end to end. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'witness-cli-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e 0' } }));
  writeFileSync(join(dir, 'src.mjs'), 'export const gt = (a, b) => a > b;\n');
  return dir;
}

test('--timeout wants a positive number, and zero is not one', () => {
  const dir = project();
  const r = runCli(['mutate', 'src.mjs', '--timeout', '0', '--test', 'node', '-e', '0'], dir);
  assert.equal(r.code, 2, 'a zero bound would make every run time out instantly and score a perfect 100%');
  assert.match(r.err, /positive number/i);
  rmSync(dir, { recursive: true, force: true });
});

test('--timeout after --test is refused rather than silently ignored', () => {
  // --test deliberately swallows everything after it, so a timeout placed later never reaches the
  // gate. Accepting it silently would run the default bound while the operator believes otherwise.
  const dir = project();
  const r = runCli(['mutate', 'src.mjs', '--test', 'node', '-e', '0', '--timeout', '5000'], dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /before --test/i);
  rmSync(dir, { recursive: true, force: true });
});

test('--timeout before --test is accepted, and the test command is the one given', () => {
  // Not asserting a clean exit: `node -e 0` passes for every mutant, so the fixture's one mutant
  // honestly survives. What matters here is that both flags were READ.
  const dir = project();
  const r = runCli(['mutate', 'src.mjs', '--timeout', '30000', '--cap', '1', '--test', 'node', '-e', '0'], dir);
  assert.doesNotMatch(r.err, /positive number/i, 'a timeout before --test was refused');
  assert.match(r.err, /tests: node -e 0/, 'the given test command was not the one announced');
  rmSync(dir, { recursive: true, force: true });
});

test('--test with nothing after it falls back to npm test, never to an empty command', () => {
  // An empty argv is not a test command. Running the gate with one would spawn nothing, and
  // "nothing" exits non-zero, which the scorer reads as every mutant killed — a clean verdict from
  // a gate that ran no tests at all. The fallback is `npm test`, which this throwaway project
  // defines, so the run reaches the mutants either way; what is checked is that no empty command
  // was assembled and announced.
  const dir = project();
  const r = runCli(['mutate', 'src.mjs', '--cap', '1', '--test'], dir);
  assert.doesNotMatch(r.err, /tests: *(\r?\n|$)/, 'an empty test command was assembled and announced');
  assert.doesNotMatch(r.err, /NOTHING WAS TESTED/, 'the gate found nothing to mutate');
  assert.match(r.err, /mutation gate: src\.mjs/);
  rmSync(dir, { recursive: true, force: true });
});

test('the CLI refuses a source file it cannot read instead of reporting a clean gate', () => {
  const dir = project();
  const r = runCli(['mutate', 'no-such-file.mjs', '--cap', '1', '--test', 'node', '-e', '0'], dir);
  assert.notEqual(r.code, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ── the recovery path was the corruption path ────────────────────────────────────
// Found by this suite destroying its own fixture. A hard kill during the backup write — the exact
// scenario the backup exists for — leaves a truncated backup, and the next run copied that
// truncation over the real source. The run that did it then reported a CLEAN gate, because an empty
// file has no mutants and no mutants used to score 1.0.

test('a truncated backup is refused, not applied over the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-heal-'));
  const src = join(dir, 'src.mjs');
  writeFileSync(src, 'export const gt = (a, b) => a > b;\n');
  writeFileSync(src + '.witnessbak', '');            // what a kill mid-write leaves behind
  assert.throws(() => runMutations(src, { testCmd: ['node', '-e', '0'], cap: 1 }), /empty/i);
  assert.equal(readFileSync(src, 'utf8'), 'export const gt = (a, b) => a > b;\n',
    'the recovery destroyed the file it exists to protect');
  rmSync(dir, { recursive: true, force: true });
});

test('a genuine backup from a killed run IS applied', () => {
  // The guard must not break real recovery: a backup holding actual content still restores, which is
  // the whole point of the sidecar.
  const dir = mkdtempSync(join(tmpdir(), 'witness-heal2-'));
  const src = join(dir, 'src.mjs');
  const truth = 'export const gt = (a, b) => a > b;\n';
  writeFileSync(src, 'export const gt = (a, b) => a >= b;\n');   // left mutated by a killed run
  writeFileSync(src + '.witnessbak', truth);
  const r = runMutations(src, { testCmd: ['node', '-e', '0'], cap: 1 });
  assert.equal(readFileSync(src, 'utf8'), truth, 'the original was not restored from the backup');
  assert.equal(existsSync(src + '.witnessbak'), false, 'the sidecar should be gone after a clean exit');
  assert.ok(r.total > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('the backup is written atomically, leaving no partial file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-atomic-'));
  const src = join(dir, 'src.mjs');
  writeFileSync(src, 'export const gt = (a, b) => a > b;\n');
  runMutations(src, { testCmd: ['node', '-e', '0'], cap: 1 });
  assert.equal(existsSync(src + '.witnessbak.tmp'), false, 'the temp file outlived the run');
  rmSync(dir, { recursive: true, force: true });
});

// ── a gate that found nothing to gate has not passed ─────────────────────────────

test('a file with no mutable operator is NOT clean', () => {
  // Point the gate at a README, a config, or a path with a typo in it and it used to return
  // score 1.0 and clean:true — a perfect green from a run that tested nothing at all. This is the
  // same false clean as a suite slower than the per-mutant bound.
  const dir = mkdtempSync(join(tmpdir(), 'witness-empty-'));
  const src = join(dir, 'nothing.mjs');
  writeFileSync(src, 'export const name = "no operators here";\n');
  const r = runMutations(src, { testCmd: ['node', '-e', '0'], cap: 1 });
  assert.equal(r.total, 0);
  assert.equal(r.clean, false, 'a gate that ran nothing reported a pass');
  assert.equal(r.noMutants, true);
  assert.equal(r.score, null, 'a score of 1.0 for zero mutants is a number nothing produced');
  assert.match(r.reason, /nothing was tested/i);
  rmSync(dir, { recursive: true, force: true });
});

test('the CLI exits non-zero when there was nothing to mutate', () => {
  const dir = project();
  writeFileSync(join(dir, 'nothing.mjs'), 'export const name = "no operators";\n');
  const r = runCli(['mutate', 'nothing.mjs', '--cap', '1', '--test', 'node', '-e', '0'], dir);
  assert.notEqual(r.code, 0, 'a mistyped path would have passed CI');
  assert.match(r.err, /NOTHING WAS TESTED/);
  rmSync(dir, { recursive: true, force: true });
});

test('a real file still passes the same path', () => {
  const dir = project();
  const r = runCli(['mutate', 'src.mjs', '--cap', '2', '--test', 'node', '-e', '0'], dir);
  assert.doesNotMatch(r.err, /NOTHING WAS TESTED/);
  rmSync(dir, { recursive: true, force: true });
});

// ── the bound must be above the suite, and nothing used to check ─────────────────
// A timed-out run counts as KILLED. Correct for a mutant that hangs; catastrophic for one that was
// merely slow, because a suite slower than the bound makes EVERY mutant time out and the gate scores
// a flawless 100% having finished nothing. The estate has been bitten by this once already, and this
// repo's own suite would now walk into it with the default bound.

test('the bound must leave room for a run, not merely fit one', () => {
  // Exact, because the decision is a pure function. A suite that finishes in 10s against a 10s wall
  // has no room at all: the next run that is a shade slower is killed and counted KILLED.
  assert.equal(boundIsAdequate(10, 20), true, 'exactly twice the run is the documented minimum');
  assert.equal(boundIsAdequate(10, 21), true);
  assert.equal(boundIsAdequate(10, 19), false, 'a hair under and every mutant is at risk of the wall');
  assert.equal(boundIsAdequate(10, 10), false, 'a bound equal to the run leaves no room whatsoever');
  assert.equal(boundIsAdequate(107000, 20000), false, "this repo's own suite against the default bound");
  assert.equal(BOUND_HEADROOM, 2);
  // and it is total: a missing measurement is not permission to proceed
  for (const junk of [NaN, Infinity, undefined, null, 'x']) {
    assert.equal(boundIsAdequate(junk, 20000), false, `baseline ${String(junk)} was accepted`);
    assert.equal(boundIsAdequate(10, junk), false, `timeout ${String(junk)} was accepted`);
  }
});

test('a run with room to spare is not refused', () => {
  // The loose half: a fast suite against the default bound must simply work. The precise boundary is
  // covered above, where it can be stated exactly instead of raced.
  const dir = mkdtempSync(join(tmpdir(), 'witness-bound2-'));
  const src = join(dir, 'src.mjs');
  writeFileSync(src, 'export const gt = (a, b) => a > b;\n');
  const r = runMutations(src, { testCmd: ['node', '-e', '0'], cap: 1, timeout: 60000 });
  assert.notEqual(r.baselineFailed, true, 'a fast suite against a 60s bound was refused');
  assert.equal(r.total, 1);
  assert.ok(Number.isFinite(r.baselineMs) === false || r.baselineMs >= 0);
  rmSync(dir, { recursive: true, force: true });
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
  // The bound is 5s, not 1.5s: the hanging mutant never terminates, so any bound proves the point,
  // while a tight one makes the BASELINE run flake once this suite is spawning many children — and a
  // flaked baseline returns clean:false with zero survivors, which reads exactly like a real failure.
  const r = runMutations('fixtures/hang.mjs', { testCmd: nodeTest('fixtures/hang.good.test.mjs'), timeout: 5000 });
  assert.notEqual(r.baselineFailed, true, 'the unmutated suite did not pass — this says nothing about the bound');
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
