#!/usr/bin/env node
// witness suggest · a surviving mutant becomes a suggested killing test, checked before it is shown (SUGGEST.md).
//
//   1 RECORD   run the project's tests once, on the real code, with a module hook that wraps the kernel's exported
//              functions and records every call's arguments (NODE_OPTIONS, so test runners' child processes record too)
//   2 SEARCH   for each survivor, call the real code and the mutant side by side (in a child process, bounded: a
//              mutant can loop forever) on the recorded calls, then on inputs one change away from them (a boundary
//              number written on the mutated line first), then on plain hostile inputs; keep the first that differ
//   3 VERIFY   write that input and the real code's answer as a test; keep it only if it PASSES on the real code and
//              FAILS on the mutant, both run for real. Nothing unverified is ever written to the output.
//
// It never writes to the source file (a mutant is its own file beside it, removed after), and it changes nothing in
// the gate: witness's verdicts are untouched. Output: one test file for a person to read, name and keep.
//
//   node suggest.mjs <source> [--survivors <witness mutate JSON>] [--out <file>] [--timeout MS] --test <cmd...>
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, basename, extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { deserialize, serialize } from 'node:v8';
import { mutants, hostileInputs, runMutations, isEntry } from './witness.mjs';
import { variants, hints, candidatesFor, renderTest } from './suggest-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'suggest-worker.mjs');
const IDENT = /^[A-Za-z_$][\w$]*$/;
const b64 = (x) => serialize(x).toString('base64');
const unb64 = (s) => deserialize(Buffer.from(s, 'base64'));
const nodeCmd = (cmd) => (cmd[0] === 'node' ? [process.execPath, ...cmd.slice(1)] : cmd);
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_OPTIONS; delete e.NODE_TEST_CONTEXT; return e; };

// recording needs module.registerHooks (Node 22.15 / 23.5 and later). On an older Node, suggest says so and does not
// pretend: a record with no calls would look like "nothing found" when nothing was looked at.
import * as nodeModule from 'node:module';   // a namespace import: a named one would fail to load on Node 20
export const SUPPORTED = typeof nodeModule.registerHooks === 'function';
export const NEEDS = 'witness suggest needs Node 22.15 or later (it records your tests\' calls through module.registerHooks); this is Node ' + process.versions.node;

/** the exported names of a module, and the keys of its default export when that is a plain object of functions */
async function exportsOf(url) {
  const ns = await import(url + (url.includes('?') ? '&' : '?') + 'witness-names');
  const names = Object.keys(ns).filter((n) => n !== 'default' && IDENT.test(n));
  const d = ns.default, dkeys = d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d) : null;
  return { names, hasDefault: 'default' in ns, dkeys, fnNames: [...names.filter((n) => typeof ns[n] === 'function'), ...(dkeys ? dkeys.filter((k) => typeof d[k] === 'function').map((k) => 'default.' + k) : typeof d === 'function' ? ['default'] : [])] };
}

/** step 1: run the tests on the real code and record every call to the kernel's exported functions */
export async function record(srcPath, testCmd, { cwd = process.cwd(), timeout = 600000 } = {}) {
  if (!SUPPORTED) throw new Error(NEEDS);
  const src = pathToFileURL(realpathSync(srcPath)).href, ex = await exportsOf(src);
  const dir = mkdtempSync(join(tmpdir(), 'witness-suggest-'));
  try {
    const wrap = pathToFileURL(join(dir, 'wrap.mjs')).href, out = join(dir, 'rec-');
    writeFileSync(join(dir, 'wrap.mjs'), [
      'import * as O from ' + JSON.stringify(src + '?witness-orig') + ';',
      "import { serialize } from 'node:v8';",
      "import { writeFileSync } from 'node:fs';",
      'const REC = [], seen = new Set();',
      "const rec = (n, a) => { if (REC.length >= 20000) return; let b; try { b = serialize(a).toString('base64'); } catch { return; } const k = n + '\\0' + b; if (seen.has(k)) return; seen.add(k); REC.push([n, b]); };",
      "process.on('exit', () => { try { writeFileSync(" + JSON.stringify(out) + " + process.pid + '-' + Math.random().toString(36).slice(2) + '.json', JSON.stringify(REC)); } catch {} });",
      'const isClass = (f) => /^class\\b/.test(Function.prototype.toString.call(f));',
      "const wrap = (n, f) => (typeof f !== 'function' || isClass(f) ? f : Object.defineProperties(function (...a) { rec(n, a); return f.apply(this, a); }, { name: { value: f.name }, length: { value: f.length } }));",
      ...ex.names.map((n) => 'export const ' + n + ' = wrap(' + JSON.stringify(n) + ', O.' + n + ');'),
      ...(ex.hasDefault ? ['const D = O.default;', "export default (D && typeof D === 'object' && !Array.isArray(D) ? Object.fromEntries(Object.keys(D).map((k) => [k, wrap('default.' + k, D[k])])) : wrap('default', D));"] : []),
    ].join('\n') + '\n');
    writeFileSync(join(dir, 'hooks.mjs'), [
      "import { registerHooks } from 'node:module';",
      'const SRC = ' + JSON.stringify(src) + ', WRAP = ' + JSON.stringify(wrap) + ';',
      "const norm = (u) => (process.platform === 'win32' ? String(u).toLowerCase() : String(u));",
      'registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); return r && norm(r.url) === norm(SRC) ? { ...r, url: WRAP, shortCircuit: true } : r; } });',
    ].join('\n') + '\n');
    const env = cleanEnv();
    env.NODE_OPTIONS = '--import="' + pathToFileURL(join(dir, 'hooks.mjs')).href + '"';
    const c = nodeCmd(testCmd), r = spawnSync(c[0], c.slice(1), { cwd, env, timeout, encoding: 'utf8', maxBuffer: 1 << 28 });
    const seen = new Set(), calls = [];
    for (const f of readdirSync(dir).filter((x) => x.startsWith('rec-'))) {
      let list = [];
      try { list = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { /* a process that died mid-write */ }
      for (const [n, b] of list) { const k = n + '\0' + b; if (!seen.has(k)) { seen.add(k); calls.push([n, b]); } }
    }
    return { calls, fnNames: ex.fnNames, testsPassed: r.status === 0, status: r.status };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** the inputs to try for one survivor: the recorded calls, then one change away from each, then plain hostile inputs */
export function inputsFor(calls, fnNames, snippet, cap = 4000) {
  const h = hints(snippet), out = [], seen = new Set();
  const add = (n, b) => { const k = n + '\0' + b; if (!seen.has(k) && out.length < cap) { seen.add(k); out.push([n, b]); } };
  for (const [n, b] of calls) add(n, b);
  for (const [n, b] of calls) { if (out.length >= cap) break; let a; try { a = unb64(b); } catch { continue; } for (const v of variants(a, h, 60, (x) => b64(x))) { try { add(n, b64(v)); } catch { /* not storable */ } } }
  const plain = hostileInputs().filter(([, x]) => typeof x !== 'function' && !(typeof x === 'string' && x.length > 1000) && !(Array.isArray(x) && x.length > 1000)).map(([, x]) => x);
  for (const n of fnNames) { add(n, b64([])); for (const x of plain) { try { add(n, b64([x])); } catch { /* circular, toxic */ } } }
  return out;
}

const parse = (r) => String(r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/** run the worker on one mutant; return its differences, and an input the mutant never came back from while the real
 *  code did. An input that neither comes back from is skipped and the search resumes after it, within the budget. */
export function compare(origUrl, mutUrl, calls, { want = 3, ms = 3000, timeout = 10000, budget = 90000, dir }) {
  const pay = join(dir, 'pay-' + Math.random().toString(36).slice(2) + '.json');
  const t0 = Date.now(), diffs = [], skipped = [];
  let from = 0, done = false, hung = null, tried = 0, error = null;
  while (!done && !hung && diffs.length < want && from < calls.length && Date.now() - t0 < budget) {
    const part = calls.slice(from);
    writeFileSync(pay, JSON.stringify({ orig: origUrl, mut: mutUrl, calls: part, want: want - diffs.length, ms }));
    const r = spawnSync(process.execPath, [WORKER, pay], { env: cleanEnv(), timeout, encoding: 'utf8', maxBuffer: 1 << 28 });
    const lines = parse(r);
    for (const l of lines) if (l.diff) diffs.push({ ...l, i: l.i + from });
    tried += lines.filter((l) => l.start).length;
    done = lines.some((l) => l.done);
    if (done) break;
    const last = lines[lines.length - 1];
    if (!last || !last.start) { error = String(r.stderr || '').slice(-400) || 'the worker gave no output'; break; }
    // it never came back from this input: ask the real code alone what it gives there
    const at = last.i + from;
    writeFileSync(pay, JSON.stringify({ orig: origUrl, calls, only: at, ms }));
    const got = parse(spawnSync(process.execPath, [WORKER, pay], { env: cleanEnv(), timeout, encoding: 'utf8' })).find((l) => l.expectB64 !== undefined);
    if (got && got.expectB64) hung = { i: at, name: got.name, expectB64: got.expectB64, expect: got.expect };
    else { skipped.push(at); from = at + 1; }   // the real code does not come back either: not a difference, move on
  }
  if (!done && !hung && diffs.length < want && from < calls.length && !error) error = 'the search ran out of time (' + budget + ' ms)';
  return { diffs, hung, done: done || from >= calls.length, tried, skipped, error };
}

const runFile = (file, cwd, timeout) => spawnSync(process.execPath, [file], { cwd, env: cleanEnv(), timeout, encoding: 'utf8' }).status;

/** steps 2 and 3 for every survivor; write the verified tests; return what was found and why not where it was not */
export async function suggest(srcPath, { survivors, testCmd, cwd = process.cwd(), timeout = 30000, out, want = 3 } = {}) {
  const abs = realpathSync(resolve(cwd, srcPath)), dir = dirname(abs), ext = extname(abs) || '.mjs', base = basename(abs);
  const original = readFileSync(abs, 'utf8'), origUrl = pathToFileURL(abs).href;
  const rec = await record(abs, testCmd, { cwd });
  const all = mutants(original), report = [], kept = [];
  const work = mkdtempSync(join(tmpdir(), 'witness-suggest-w-'));
  const made = [];
  try {
    for (const s of Array.isArray(survivors) ? survivors : []) {
      const cands = candidatesFor(all, s).slice(0, 4);
      const row = { line: s.line, mutation: s.mutation, snippet: s.snippet, candidates: cands.length, killed: 0, cases: [], why: null };
      if (!cands.length) { row.why = 'no mutant on this line matches (the line has changed since the run)'; row.status = 'none'; report.push(row); continue; }
      const inputs = inputsFor(rec.calls, rec.fnNames, s.snippet);
      let k = 0;
      for (const m of cands) {
        const mutFile = join(dir, '.' + base + '.witness-suggest-' + (k++) + ext);
        writeFileSync(mutFile, m.source); made.push(mutFile);
        const c = compare(origUrl, pathToFileURL(mutFile).href, inputs, { want, dir: work });
        const tries = [...c.diffs.filter((d) => d.expectB64).map((d) => ({ name: d.name, argsB64: inputs[d.i][1], expectB64: d.expectB64, expect: d.expect })), ...(c.hung ? [{ name: c.hung.name, argsB64: inputs[c.hung.i][1], expectB64: c.hung.expectB64, expect: c.hung.expect, hang: true }] : [])];
        let ok = null;
        for (const t of tries) {
          const kase = { survivor: s, name: t.name, args: unb64(t.argsB64), argsB64: t.argsB64, expect: t.expect, expectB64: t.expectB64 };
          const real = join(dir, '.witness-suggest-check' + '.mjs'), mut = join(dir, '.witness-suggest-check-m' + '.mjs');
          made.push(real, mut);
          writeFileSync(real, renderTest({ importPath: './' + base, cases: [kase] }));
          writeFileSync(mut, renderTest({ importPath: './' + basename(mutFile), cases: [kase] }));
          const passReal = runFile(real, dir, timeout) === 0, failMut = runFile(mut, dir, timeout) !== 0;
          if (passReal && failMut) { ok = { ...kase, hang: !!t.hang }; break; }
        }
        if (ok) { row.killed++; row.cases.push(ok); kept.push(ok); }
        else if (!row.why) row.why = !inputs.length ? 'no input to try: no exported function was called and none can be called without arguments'
          : tries.length ? 'an input changed the answer, but the test written from it did not pass on the real code and fail on the mutant'
            : c.done ? 'none of the ' + inputs.length + ' inputs tried gave a different answer (an equivalent mutant, or one reached only through state, the clock, the disk or a callback)'
              : 'the comparison stopped early (' + (c.error || 'no output') + ')';
      }
      row.status = row.killed === cands.length ? 'killed' : row.killed ? 'partly' : 'none';
      report.push(row);
    }
  } finally {
    for (const f of made) rmSync(f, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
  const file = out ? resolve(cwd, out) : join(dir, base.replace(/\.(m?js)$/, '') + '.witness-suggested.test.mjs');
  if (kept.length) {
    let imp = relative(dirname(file), abs).split(sep).join('/');
    if (!imp.startsWith('.')) imp = './' + imp;
    writeFileSync(file, renderTest({ importPath: imp, cases: kept }));
  }
  return { source: srcPath, recorded: rec.calls.length, testsPassed: rec.testsPassed, survivors: report.length, killed: report.filter((r) => r.status === 'killed').length, file: kept.length ? file : null, report: report.map(({ cases, ...r }) => ({ ...r, tests: cases.map((c) => c.name) })) };
}

async function main() {
  if (!SUPPORTED) { console.error('✗ ' + NEEDS); process.exit(2); }
  const a = process.argv.slice(2), ti = a.indexOf('--test');
  const head = ti >= 0 ? a.slice(0, ti) : a, testCmd = ti >= 0 ? a.slice(ti + 1) : null;
  const opt = (f) => { const i = head.indexOf(f); return i >= 0 ? head[i + 1] : undefined; };
  const src = head[0];
  if (!src || src.startsWith('--') || !testCmd || !testCmd.length) { console.error('usage: node suggest.mjs <source> [--survivors <witness mutate JSON>] [--out <file>] [--timeout MS] --test <cmd...>'); process.exit(2); }
  let survivors;
  if (opt('--survivors')) survivors = JSON.parse(readFileSync(opt('--survivors'), 'utf8')).survived;
  else {
    console.error('witness suggest: running the mutation gate first to find the survivors …');
    const r = runMutations(src, { testCmd, cap: 2000, timeout: opt('--timeout') ? Number(opt('--timeout')) : undefined });
    if (r.baselineFailed || r.noMutants) { console.error('✗ the gate did not run: ' + r.reason); process.exit(2); }
    survivors = r.survived;
  }
  const r = await suggest(src, { survivors, testCmd, out: opt('--out') });
  console.log(JSON.stringify(r, null, 2));
  console.error((r.file ? '✓ ' : '· ') + r.killed + ' of ' + r.survivors + ' survivor(s) have a verified killing test' + (r.file ? ': ' + r.file : '') + ' (from ' + r.recorded + ' recorded call(s))');
  process.exit(0);
}
if (isEntry(process.argv[1], import.meta.url)) main();
