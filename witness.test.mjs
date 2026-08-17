#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mutants, commentMask, runMutations, fuzz, hostileInputs, OPERATORS, MIN_REASON_CHARS, boundIsAdequate, BOUND_HEADROOM, reapTree } from './witness.mjs';
import { spawn } from 'node:child_process';

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
  // ⚑ This asserted `tests:` was not followed by end-of-line — but the announcement ends with " …",
  // so an EMPTY command printed "· tests:  …" and sailed past. The mutant survived the gate because
  // of that. What is actually meant is that no test-command suffix is announced at all.
  assert.doesNotMatch(r.err, /· tests:/, 'an empty test command was assembled and announced');
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

// ── a timeout must kill the tree, not just the child it started ──────────────────
// spawnSync's `timeout` signals the process it started, and that process is almost never the one
// doing the work: `npm test` spawns `sh`, which spawns `node`. Killing npm left the grandchildren
// running. Gating this file on a GitHub runner leaked 324 processes and the job was SIGTERMed at 75
// minutes without ever printing a score; the same leak locally left 301 node processes alive and
// turned a 3-hour run into a 5-hour one. Orphans slow the machine, slow runs hit the wall, and a
// timed-out run orphans more — it compounds.

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A suite that starts a long-lived grandchild, records its pid, then hangs past the bound. */
function leakyProject(hang) {
  const dir = mkdtempSync(join(tmpdir(), 'witness-orphan-'));
  writeFileSync(join(dir, 'src.mjs'), 'export const gt = (a, b) => a > b;\n');
  writeFileSync(join(dir, 'suite.mjs'), [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    // a grandchild that would outlive its parent forever if nobody reaped it
    "const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync(process.env.PID_FILE, String(kid.pid));",
    hang ? "setInterval(() => {}, 1000);" : "setTimeout(() => process.exit(0), 150);",
  ].join('\n'));
  return { dir, pidFile: join(dir, 'kid.pid') };
}

test('a timed-out run leaves no orphaned grandchild behind', () => {
  const { dir, pidFile } = leakyProject(true);
  const prev = process.env.PID_FILE;
  process.env.PID_FILE = pidFile;
  try {
    // The suite hangs, so the run hits the bound. Before the fix the grandchild survived that kill.
    runMutations(join(dir, 'src.mjs'), { testCmd: ['node', join(dir, 'suite.mjs')], cap: 1, timeout: 2500 });
    const kid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(kid) && kid > 0, 'the fixture never reported a grandchild pid');
    assert.equal(alive(kid), false, `grandchild ${kid} outlived the run that started it`);
  } finally {
    if (prev === undefined) delete process.env.PID_FILE; else process.env.PID_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that exits normally is also swept', () => {
  // Not only timeouts: a suite can leak a daemon on its way out just as easily, and the next mutant
  // then races it. The sweep happens after every run.
  const { dir, pidFile } = leakyProject(false);
  const prev = process.env.PID_FILE;
  process.env.PID_FILE = pidFile;
  try {
    runMutations(join(dir, 'src.mjs'), { testCmd: ['node', join(dir, 'suite.mjs')], cap: 1, timeout: 30000 });
    const kid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(alive(kid), false, `grandchild ${kid} survived a clean run`);
  } finally {
    if (prev === undefined) delete process.env.PID_FILE; else process.env.PID_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reapTree refuses to signal anything it does not own', () => {
  // The negative-pid kill is only safe because the child was spawned detached into its own group.
  // Without that it shares OUR group, and the same call would take witness down with it — so the
  // function refuses rather than guessing, and never signals this process under any argument.
  assert.equal(reapTree(process.pid, true), false, 'it would have signalled itself');
  assert.equal(reapTree(0, true), false);
  assert.equal(reapTree(null, true), false);
  assert.equal(reapTree(undefined, true), false);
  if (process.platform !== 'win32') {
    assert.equal(reapTree(999999, false), false, 'a non-detached child has no group of its own to kill');
  }
  assert.ok(alive(process.pid), 'witness survived its own reaper');
});

// ── the comment scanner's remaining decisions ────────────────────────────────────
// Each of these survived the self-gate. They survived because the existing tests happened to produce
// the same mutant COUNT either way — the scanner went wrong somewhere the count could not see. The
// fix in every case is a sample where being wrong changes what is offered for mutation.

test('a lone slash does not open a block comment', () => {
  // `c === '/' && d === '*'` collapsed to `||` makes any slash — or any star — start a block
  // comment, and with no closing marker the mask runs to end of file, hiding everything after a
  // division from the gate.
  const src = 'const r = a / b;\nconst live = c === d;';
  assert.deepEqual(mutants(src).map(m => m.from), ['===']);
  const withStar = 'const r = a * b;\nconst live = c === d;';
  assert.deepEqual(mutants(withStar).map(m => m.from), ['===']);
});

test('a comment marker inside a string cannot hide code on the SAME line', () => {
  // The earlier test put the live operator on the next line, so masking to end-of-line changed
  // nothing and the mutant survived. Keep the operator on the line the string is on.
  const src = 'const u = "http://x" + (a === b);';
  assert.deepEqual(mutants(src).map(m => m.from), ['===']);
});

test('every quote character opens a string, not just the first one tested', () => {
  for (const q of ['"', "'", '`']) {
    const src = `const u = ${q}http://x${q} + (a === b);`;
    assert.deepEqual(mutants(src).map(m => m.from), ['==='], `${q} did not open a string`);
  }
});

test('a string ends at its own quote, not at the first character inside it', () => {
  // Inverting the closing test ends the string immediately, so its contents are read as code and
  // the real closing quote opens a second one that swallows what follows.
  const src = 'const s = "a === b"; const live = c === d;';
  assert.equal(mutants(src).length, 2, 'both the string body and the live operator are offered');
  const after = 'const s = "xx"; const live = c === d;';
  assert.deepEqual(mutants(after).map(m => m.from), ['===']);
});

// ── the rest of the command line ─────────────────────────────────────────────────
// --timeout and --test had tests; --cap, --baseline, the fuzz subcommand and the refused-exemption
// report did not, and all of them survived. Every one is an argument the gate acts on.

test('--cap is read, and bounds the run', () => {
  const dir = project();
  writeFileSync(join(dir, 'many.mjs'),
    'export const a = (x, y) => x > y;\nexport const b = (x, y) => x < y;\nexport const c = (x, y) => x === y;\n');
  const r = runCli(['mutate', 'many.mjs', '--cap', '2', '--test', 'node', '-e', '0'], dir);
  const out = JSON.parse(r.out);
  assert.equal(out.total, 2, '--cap was not read, or was read from the wrong position');
  assert.equal(out.capped, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('--baseline is read from the path given, not guessed', () => {
  const dir = project();
  const ms = mutants(readFileSync(join(dir, 'src.mjs'), 'utf8'));
  const entry = [{
    mutation: `${ms[0].from} → ${ms[0].to}`,
    snippet: 'export const gt = (a, b) => a > b;',
    reason: 'the fixture has no assertions at all, so this survivor is expected and named here on purpose',
  }];
  writeFileSync(join(dir, 'my-baseline.json'), JSON.stringify(entry));
  const r = runCli(['mutate', 'src.mjs', '--baseline', 'my-baseline.json', '--test', 'node', '-e', '0'], dir);
  const out = JSON.parse(r.out);
  assert.equal(out.ignored.length, 1, 'the named baseline file was not loaded');
  assert.equal(out.survived.length, 0);
  assert.equal(r.code, 0, 'a fully-exempted run is clean');
  rmSync(dir, { recursive: true, force: true });
});

test('a REFUSED baseline entry is announced and still counts as a survivor', () => {
  const dir = project();
  const ms = mutants(readFileSync(join(dir, 'src.mjs'), 'utf8'));
  writeFileSync(join(dir, 'my-baseline.json'), JSON.stringify([{
    mutation: `${ms[0].from} → ${ms[0].to}`,
    snippet: 'export const gt = (a, b) => a > b;',
    reason: 'too short',
  }]));
  const r = runCli(['mutate', 'src.mjs', '--baseline', 'my-baseline.json', '--test', 'node', '-e', '0'], dir);
  assert.match(r.err, /baseline entry REFUSED/, 'a refused exemption was swallowed');
  assert.equal(JSON.parse(r.out).survived.length, 1, 'and the mutant it named must count against clean');
  assert.notEqual(r.code, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('the fuzz subcommand runs, and passes a guarded function', () => {
  const dir = project();
  writeFileSync(join(dir, 'safe.mjs'), 'export function safe(x) { try { return String(x).length; } catch { return 0; } }\n');
  const r = runCli(['fuzz', 'safe.mjs', 'safe'], dir);
  assert.equal(r.code, 0, 'a never-throwing function was reported as throwing');
  assert.equal(JSON.parse(r.out).neverThrows, true);
  rmSync(dir, { recursive: true, force: true });
});

test('the fuzz subcommand fails a function that throws on hostile input', () => {
  const dir = project();
  writeFileSync(join(dir, 'brittle.mjs'), 'export function brittle(x) { return x.length; }\n');
  const r = runCli(['fuzz', 'brittle.mjs', 'brittle'], dir);
  assert.notEqual(r.code, 0);
  assert.equal(JSON.parse(r.out).neverThrows, false);
  rmSync(dir, { recursive: true, force: true });
});

test('fuzz refuses a missing argument, and a name that is not a function', () => {
  const dir = project();
  writeFileSync(join(dir, 'safe.mjs'), 'export const notAFunction = 42;\n');
  assert.equal(runCli(['fuzz'], dir).code, 2);
  assert.equal(runCli(['fuzz', 'safe.mjs'], dir).code, 2);
  const bad = runCli(['fuzz', 'safe.mjs', 'notAFunction'], dir);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /not an exported function/);
  rmSync(dir, { recursive: true, force: true });
});

test('an unknown command and a missing source file both explain themselves', () => {
  const dir = project();
  const unknown = runCli(['wibble'], dir);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /deterministic build gate/);
  const noSrc = runCli(['mutate'], dir);
  assert.equal(noSrc.code, 2);
  assert.match(noSrc.err, /usage: witness mutate/);
  rmSync(dir, { recursive: true, force: true });
});

test('an error report survives a value whose message cannot be read', () => {
  // fuzz stringifies whatever was thrown. A thrown null, or an object whose .message getter itself
  // throws, must not take the reporter down with it — the report is the only record of the failure.
  const hostile = () => { throw null; };
  return fuzz(hostile).then((r) => {
    assert.equal(r.neverThrows, false);
    assert.ok(r.throwsOn.length > 0, 'a thrown null produced no report');
    assert.ok(r.throwsOn.every(t => typeof t.error === 'string'), 'every report must carry a string');
  });
});

// ── survivors of the second self-gate ────────────────────────────────────────────
// Four decisions the suite reached but never actually judged. Each was found by re-running the
// reported survivors one at a time and asking, of every one that lived, whether ANY input could
// tell mutant from original. These four could; the answer is a test, not an exemption.

test('a baseline entry missing half its identity is dropped, not announced as REFUSED', () => {
  // The malformed-entry guard is `!e || !e.mutation || !e.snippet`. Weaken either `||` and a
  // half-formed entry — a snippet with no mutation, say — stops being skipped, falls through to the
  // reason check, and is REPORTED AS REFUSED. That invents a verdict about a mutant the entry never
  // named. The existing tests only ever fed it well-formed entries.
  const dir = project();
  writeFileSync(join(dir, 'my-baseline.json'), JSON.stringify([{ snippet: 'export const gt = (a, b) => a > b;' }]));
  const r = runCli(['mutate', 'src.mjs', '--baseline', 'my-baseline.json', '--test', 'node', '-e', '0'], dir);
  assert.doesNotMatch(r.err, /baseline entry REFUSED/,
    'an entry naming no mutant was refused — a verdict about nothing');
  writeFileSync(join(dir, 'my-baseline.json'), JSON.stringify([{ mutation: '> → >=' }]));
  const r2 = runCli(['mutate', 'src.mjs', '--baseline', 'my-baseline.json', '--test', 'node', '-e', '0'], dir);
  assert.doesNotMatch(r2.err, /baseline entry REFUSED/, 'and the same the other way round');
  rmSync(dir, { recursive: true, force: true });
});

test('fuzz refuses a HALF-given argument pair, with the usage line', () => {
  // `!modulePath || !exportName` weakened to `&&` refuses only when BOTH are missing, so naming a
  // module and omitting the export sails past the guard into the dynamic import. The old test
  // asserted only the exit code — which is 2 either way — so it walked straight through.
  const dir = project();
  writeFileSync(join(dir, 'safe.mjs'), 'export const notAFunction = 42;\n');
  const half = runCli(['fuzz', 'safe.mjs'], dir);
  assert.equal(half.code, 2);
  assert.match(half.err, /usage: witness fuzz/, 'it got past the guard and failed later instead');
  const none = runCli(['fuzz'], dir);
  assert.equal(none.code, 2);
  assert.match(none.err, /usage: witness fuzz/);
  rmSync(dir, { recursive: true, force: true });
});

test('the error report carries the real message, not the shape of one', async () => {
  // `String(e && e.message || e)` reports the message when there is one and the thrown value when
  // there is not. Collapse the `||` and an Error reports "Error: boom" while a thrown string reports
  // "undefined" — the report is the only record of the failure, so assert what it SAYS. Asserting
  // merely that it is a string can never fail: String() always returns one.
  const r = await fuzz(() => { throw new Error('boom'); });
  assert.equal(r.throwsOn[0].error, 'boom', 'an Error must report its message');
  const s = await fuzz(() => { throw 'disk on fire'; });
  assert.equal(s.throwsOn[0].error, 'disk on fire', 'a thrown string IS the record');
});

test('reapTree reports whether the kill actually landed', () => {
  // The return value is the difference between "I killed the tree" and "there was nothing to kill",
  // and both arms were unguarded. A reaper that always claims success is one nobody can debug.
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', detached: process.platform !== 'win32' });
  const landed = reapTree(kid.pid, process.platform !== 'win32');
  assert.equal(landed, true, 'killing a live process group was reported as a failure');

  // A signal that THREW must come back false. Claiming a kill that never happened is the failure
  // mode here: the sweep is the last thing standing between a killed run and a mutant left on disk,
  // and a caller that believes a false success stops looking.
  //
  // Portable, deliberately. On POSIX an already-dead group makes process.kill throw ESRCH, which is
  // the everyday case. On Windows taskkill just returns non-zero for a missing pid and nothing
  // throws, so that branch alone would leave this arm unasserted there — and it did: the mutant
  // survived on Windows while dying on Linux. A pid that cannot even be stringified reaches the
  // catch on both.
  // NB not a Symbol: String(sym) is specified to return "Symbol(x)" rather than throw, so it sails
  // through the Windows branch and reports success. A value whose toString throws reaches the catch
  // on both platforms — on POSIX because -pid is then NaN and process.kill rejects it.
  const unstringifiable = { toString() { throw new TypeError('this pid cannot be read'); } };
  assert.equal(reapTree(unstringifiable, true), false, 'a kill that threw was reported as a success');
  if (process.platform !== 'win32') {
    const gone = spawnSync(process.execPath, ['-e', '0']);
    assert.equal(reapTree(gone.pid, true), false, 'reaping an already-dead group was reported as a kill');
  }

  // And it must never throw, whatever it is handed. This runs in a `finally`-shaped cleanup path;
  // one that throws would take the gate down mid-run and leave a mutant on disk.
  // NB the failure message must not stringify the value: one of these throws on toString, which is
  // the whole point of including it, and building the message would throw before the assertion ran.
  const junkValues = [Symbol('x'), unstringifiable, {}, [], 'not a pid', NaN, Infinity, -0, true];
  for (const [i, junk] of junkValues.entries()) {
    assert.doesNotThrow(() => reapTree(junk, true), `reapTree threw on junkValues[${i}]`);
    assert.doesNotThrow(() => reapTree(junk, false), `reapTree threw on junkValues[${i}] undetached`);
  }
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
