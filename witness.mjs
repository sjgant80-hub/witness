// ════════════════════════════════════════════════════════════════
// witness · a deterministic build gate — catch test-theatre and throw-on-malformed BEFORE you push
//
// Four adversarial LLM audit passes across the estate found two classes of problem over and over:
//   1. TEST-THEATRE — a test that stays green even when the behaviour it names is broken.
//   2. THROW-ON-MALFORMED — a validate/verify/classify function that crashes on hostile input
//      (null, BigInt, circular, a toxic getter, a huge array) instead of returning a safe result.
// Both are catchable WITHOUT a language model, deterministically, in seconds:
//   • MUTATION gate — flip one operator in the source, run the tests. If they still pass, that line is
//     unguarded (theatre). A surviving mutant is a hole a real regression would fall straight through.
//   • FUZZ gate — throw the hostile-input battery at a function. If it throws, it fails the never-throw
//     boundary contract.
//
// This is the witness discipline baked into the forge, so the estate stops needing a 1.5M-token audit
// per build. Zero dependencies (Node only — spawns the project's own test runner). Deterministic.
// ════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// A child test runner must not inherit OUR test-runner context. node:test sets NODE_TEST_CONTEXT in
// every test-file process; if the `node --test` we spawn inherits it, it switches to the child-reporter
// protocol and exits 0 even when a test FAILS — so every mutant would falsely "survive" whenever witness
// itself runs under `npm test`/CI. Scrub the leak (this bug was found BY witness, running on witness).
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// ── mutation operators ───────────────────────────────────────────────────────
// Spaced operators only, so we never mis-hit `=>`, `>=` inside `===`, or bit-shifts. Each flips the
// behaviour at exactly one point; a suite that can't tell the difference isn't testing that point.
export const OPERATORS = [
  [' >= ', ' > '], [' <= ', ' < '], [' > ', ' >= '], [' < ', ' <= '],
  [' === ', ' !== '], [' !== ', ' === '], [' == ', ' != '],
  [' && ', ' || '], [' || ', ' && '],
  ['return true', 'return false'], ['return false', 'return true'],
  [' + 1', ' - 1'], [' - 1', ' + 1'],
];

// Generate one mutant per operator occurrence (single-point mutation).
export function mutants(source) {
  const out = [];
  for (const [from, to] of OPERATORS) {
    let idx = source.indexOf(from);
    while (idx !== -1) {
      const mutated = source.slice(0, idx) + to + source.slice(idx + from.length);
      const line = source.slice(0, idx).split('\n').length;
      out.push({ line, from: from.trim(), to: to.trim(), pos: idx, source: mutated });
      idx = source.indexOf(from, idx + from.length);
    }
  }
  return out;
}

// Run the mutation gate: for each mutant, write it to srcPath, run the test command, and see if the
// tests catch it. A mutant that leaves the tests GREEN survived — that line is unguarded.
//
// CRASH-SAFE. `finally` restores on a normal finish or a thrown error, but NOT on SIGTERM/SIGKILL — a
// hard kill mid-run would leave srcPath holding a live mutant (this actually happened while dogfooding
// witness on itself). So before mutating we drop a sidecar backup holding the true original; if a prior
// run was killed, that backup is still on disk and we self-heal from it on the next run. The estate can
// never be left silently corrupted by an interrupted gate.
// opts: { testCmd?: string[], cwd?: string, cap?: number }
export function runMutations(srcPath, opts = {}) {
  const backup = srcPath + '.witnessbak';
  // Self-heal: a leftover backup means a previous run was hard-killed with srcPath mutated. The backup
  // holds the real original — restore from it before reading, so a crash never poisons the next run.
  if (existsSync(backup)) {
    writeFileSync(srcPath, readFileSync(backup, 'utf8'));
    rmSync(backup);
  }
  const original = readFileSync(srcPath, 'utf8');
  writeFileSync(backup, original);   // durable copy of truth, survives even a SIGKILL of this process
  const cwd = opts.cwd || process.cwd();
  const testCmd = opts.testCmd || ['npm', 'test'];
  const cap = opts.cap ?? 80;

  let all = mutants(original);
  const capped = all.length > cap;
  all = all.slice(0, cap);

  const survived = [];
  let killed = 0;
  try {
    for (const m of all) {
      writeFileSync(srcPath, m.source);
      const r = spawnSync(testCmd[0], testCmd.slice(1), { cwd, env: childEnv(), encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 26 });
      const passed = r.status === 0;
      if (passed) survived.push({ line: m.line, mutation: `${m.from} → ${m.to}`, snippet: lineOf(original, m.line) });
      else killed++;
    }
  } finally {
    writeFileSync(srcPath, original);   // restore on a normal finish or a thrown error
    if (existsSync(backup)) rmSync(backup);   // and drop the sidecar — a clean exit needs no self-heal
  }

  return {
    total: all.length,
    capped: capped ? all.length : false,
    killed,
    survived,
    score: all.length ? Math.round((killed / all.length) * 1000) / 1000 : 1,
    clean: survived.length === 0,
  };
}

// ── fuzz gate ────────────────────────────────────────────────────────────────
// The hostile-input battery — every value class that crashed a verify/classify/validate in the audits.
export function hostileInputs() {
  const circular = {}; circular.self = circular;
  const toxicGetter = { get x() { throw new Error('toxic getter'); }, get id() { throw new Error('toxic id'); } };
  const toxicToString = { toString() { throw new Error('toxic toString'); } };
  return [
    ['null', null], ['undefined', undefined], ['NaN', NaN], ['Infinity', Infinity],
    ['empty string', ''], ['whitespace', '   '], ['empty array', []], ['empty object', {}],
    ['true', true], ['false', false], ['BigInt', 10n], ['function', () => {}],
    ['huge string', 'x'.repeat(200000)], ['huge array', new Array(200000).fill(0)],
    ['circular object', circular], ['toxic getter', toxicGetter], ['toxic toString', toxicToString],
    ['negative', -1], ['zero', 0], ['nested', { a: { b: { c: null } } }],
  ];
}

// Throw the battery at `fn`; return the inputs that made it THROW (empty ⇒ it honours the never-throw
// boundary). Async-aware. Use for functions documented as tolerant (verify/validate/classify/parse).
export async function fuzz(fn) {
  const throwsOn = [];
  for (const [label, value] of hostileInputs()) {
    try { await fn(value); }
    catch (e) { throwsOn.push({ input: label, error: String(e && e.message || e).slice(0, 80) }); }
  }
  return { throwsOn, neverThrows: throwsOn.length === 0 };
}

function lineOf(src, n) { return (src.split('\n')[n - 1] || '').trim().slice(0, 90); }

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'mutate') {
    const [srcPath] = rest;
    if (!srcPath) { console.error('usage: witness mutate <sourceFile> [--cap N]'); process.exit(2); }
    const capArg = rest.indexOf('--cap');
    const cap = capArg !== -1 ? Number(rest[capArg + 1]) : 80;
    console.error(`mutation gate: ${srcPath} …`);
    const r = runMutations(srcPath, { cap });
    console.log(JSON.stringify(r, null, 2));
    if (!r.clean) console.error(`\n✗ ${r.survived.length} mutant(s) SURVIVED — those lines are test-theatre.`);
    else console.error(`\n✓ all ${r.total} mutants killed — the tests actually guard the behaviour.`);
    process.exit(r.clean ? 0 : 1);
  }
  if (cmd === 'fuzz') {
    const [modulePath, exportName] = rest;
    if (!modulePath || !exportName) { console.error('usage: witness fuzz <module.mjs> <exportedFnName>'); process.exit(2); }
    const mod = await import(new URL(modulePath, `file://${process.cwd()}/`).href);
    const fn = mod[exportName];
    if (typeof fn !== 'function') { console.error(`${exportName} is not an exported function`); process.exit(2); }
    const r = await fuzz(fn);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.neverThrows ? 0 : 1);
  }
  console.error('witness — deterministic build gate\n  witness mutate <sourceFile> [--cap N]\n  witness fuzz <module.mjs> <exportedFnName>');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main();
}

export default { mutants, runMutations, fuzz, OPERATORS, hostileInputs };
