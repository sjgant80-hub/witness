// witness suggest · the pure kernel: shape a value so two runs can be compared and written down, make the inputs
// to try, compare two outcomes, and write the suggested test. No disk, no clock, no network; garbage never throws.
// The orchestrator (suggest.mjs) and the worker (suggest-worker.mjs) do the I/O. Pre-registered in SUGGEST.md.
//
//   shape(x)                    a plain, serialisable copy of a value: functions by name, Map / Set / Date / RegExp /
//                               Error / bytes tagged, a cycle marked, getters that throw marked; comparable and storable
//   same(a, b)                  two outcomes are the same (both returned the same shape, or both threw the same kind)
//   hints(line)                 the numbers written on the mutated line: the boundaries a mutant moves
//   alts(x, hint)               small changes to one value: a number ±1, 0, −1, a hint ±1, an empty string or list, …
//   variants(args, hint, cap)   argument lists one change away from a recorded call, without repeats
//   candidatesFor(list, s)      the mutants of a source that match a survivor's line and operator
//   pick(ns, name)              the function a recorded name means ("f", or "default.f")
//   renderTest(spec)            the suggested test file

const isObj = (x) => x !== null && typeof x === 'object';
const MAXDEPTH = 40, MAXBYTES = 4096, MAXKEYS = 2000;

const hexOf = (u8) => { let h = ''; const n = Math.min(u8.length, MAXBYTES); for (let i = 0; i < n; i++) h += u8[i].toString(16).padStart(2, '0'); return h + (u8.length > MAXBYTES ? '…' + u8.length : ''); };

/** shape(x) → a plain copy of x that v8 can serialise and deepStrictEqual can compare */
export function shape(x, depth = 0, seen = new Set()) {
  try {
    if (x === null || x === undefined) return x;
    const t = typeof x;
    if (t === 'number' || t === 'string' || t === 'boolean' || t === 'bigint') return x;
    if (t === 'symbol') return '[symbol ' + String(x.description) + ']';
    if (t === 'function') return '[function ' + (x.name || 'anonymous') + '/' + x.length + ']';
    if (depth >= MAXDEPTH) return '[deep]';
    if (seen.has(x)) return '[circular]';
    seen.add(x);
    try {
      if (x instanceof Date) return '[date ' + (Number.isNaN(x.getTime()) ? 'invalid' : x.toISOString()) + ']';
      if (x instanceof RegExp) return '[regexp ' + String(x) + ']';
      if (x instanceof Error) return { '[error]': String(x.name), message: String(x.message) };
      if (ArrayBuffer.isView(x)) return '[bytes ' + hexOf(new Uint8Array(x.buffer, x.byteOffset, x.byteLength)) + ']';
      if (x instanceof ArrayBuffer) return '[bytes ' + hexOf(new Uint8Array(x)) + ']';
      if (x instanceof Map) return { '[map]': [...x.entries()].slice(0, MAXKEYS).map(([k, v]) => [shape(k, depth + 1, seen), shape(v, depth + 1, seen)]) };
      if (x instanceof Set) return { '[set]': [...x.values()].slice(0, MAXKEYS).map((v) => shape(v, depth + 1, seen)) };
      if (typeof x.then === 'function') return '[promise]';
      if (Array.isArray(x)) return x.slice(0, MAXKEYS).map((v) => shape(v, depth + 1, seen));
      const out = {};
      for (const k of Object.keys(x).slice(0, MAXKEYS)) {
        let v;
        try { v = x[k]; } catch { out[k] = '[throws]'; continue; }
        out[k] = shape(v, depth + 1, seen);
      }
      return out;
    } finally { seen.delete(x); }
  } catch { return '[unshapeable]'; }
}

/** same(a, b) → the two outcomes ({ ok } or { threw, message }) are indistinguishable */
export function same(a, b) {
  if (!isObj(a) || !isObj(b)) return false;
  if ('threw' in a || 'threw' in b) return a.threw === b.threw && a.message === b.message;
  return deepEq(a.ok, b.ok);
}
function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !deepEq(a[k], b[k])) return false;
  return true;
}

/** hints(line) → the distinct finite numbers written on a line of code (a boundary such as `> 400` is a hint) */
export function hints(line) {
  const out = [];
  for (const m of String(typeof line === 'string' ? line : '').matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** alts(x, hint) → small changes to one value, the ones that move a boundary first; a list or object is changed at
 *  its own level and one level in, never deeper (a value nested 60 deep must not run the stack out) */
export function alts(x, hint = [], depth = 0) {
  const h = Array.isArray(hint) ? hint.filter((n) => typeof n === 'number') : [];
  const inner = (v) => (depth < 1 ? alts(v, h, depth + 1).slice(0, 4) : []);
  if (typeof x === 'number') return [...h.flatMap((n) => [n, n - 1, n + 1]), x + 1, x - 1, 0, -1, x * 2, -x];
  if (typeof x === 'string') return [...h.filter((n) => Number.isInteger(n) && n >= 0 && n <= 100000).flatMap((n) => ['x'.repeat(n), 'x'.repeat(n + 1), n > 0 ? 'x'.repeat(n - 1) : null]).filter((s) => s !== null),
    '', x.slice(1), x.slice(0, -1), x.toUpperCase(), x.toLowerCase(), ' ' + x + ' ', x + x];
  if (typeof x === 'boolean') return [!x];
  if (x === null || x === undefined) return [0, '', [], {}, x === null ? undefined : null];
  if (Array.isArray(x)) {
    const out = [[], x.slice(1), x.slice(0, -1), [...x].reverse()];
    for (let j = 0; j < Math.min(x.length, 5); j++) for (const a of inner(x[j])) { const c = x.slice(); c[j] = a; out.push(c); }
    return out;
  }
  if (isObj(x) && Object.getPrototypeOf(x) === Object.prototype) {
    const out = [];
    for (const k of Object.keys(x).slice(0, 10)) {
      const { [k]: _, ...rest } = x;
      out.push(rest);
      for (const a of inner(x[k])) out.push({ ...x, [k]: a });
    }
    return out;
  }
  return [];
}

/** variants(args, hint, cap) → argument lists one change away from args, each once, args itself excluded */
export function variants(args, hint = [], cap = 200, key = JSON.stringify) {
  const list = Array.isArray(args) ? args : [];
  const seen = new Set(), out = [];
  const add = (a) => { let k; try { k = key(a); } catch { return; } if (k === undefined || seen.has(k)) return; seen.add(k); out.push(a); };
  add(list);
  for (let i = 0; i < list.length && out.length <= cap; i++) for (const a of alts(list[i], hint)) { const c = list.slice(); c[i] = a; add(c); if (out.length > cap) break; }
  return out.slice(1, cap + 1);
}

/** candidatesFor(list, s) → the mutants (from witness's mutants()) on the survivor's line with its operator */
export function candidatesFor(list, s) {
  if (!Array.isArray(list) || !isObj(s)) return [];
  return list.filter((m) => isObj(m) && m.line === s.line && String(m.from) + ' → ' + String(m.to) === s.mutation);
}

/** pick(ns, name) → the function a recorded name means in a module namespace, or null */
export function pick(ns, name) {
  if (!isObj(ns) || typeof name !== 'string') return null;
  let f;
  try { f = name.startsWith('default.') ? (isObj(ns.default) ? ns.default[name.slice(8)] : undefined) : ns[name]; } catch { return null; }
  return typeof f === 'function' && !/^class\b/.test(Function.prototype.toString.call(f)) ? f : null;
}

/** lit(x) → JavaScript source that builds exactly x (primitives, arrays, plain objects), or null when it cannot */
export function lit(x, depth = 0) {
  if (depth > MAXDEPTH) return null;
  if (x === undefined) return 'undefined';
  if (x === null || typeof x === 'boolean') return String(x);
  if (typeof x === 'number') return Object.is(x, -0) ? '-0' : Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : String(x);
  if (typeof x === 'bigint') return x + 'n';
  if (typeof x === 'string') return JSON.stringify(x);
  if (Array.isArray(x)) {
    if (Object.keys(x).length !== x.length) return null;   // holes or extra keys
    const parts = [];
    for (const v of x) { const s = lit(v, depth + 1); if (s === null) return null; parts.push(s); }
    return '[' + parts.join(', ') + ']';
  }
  if (isObj(x) && Object.getPrototypeOf(x) === Object.prototype && Object.getOwnPropertySymbols(x).length === 0) {
    const parts = [];
    for (const k of Object.keys(x)) {
      if (k === '__proto__') return null;
      const d = Object.getOwnPropertyDescriptor(x, k);
      if (!d || !('value' in d)) return null;   // a getter is not a value
      const s = lit(d.value, depth + 1);
      if (s === null) return null;
      parts.push(JSON.stringify(k) + ': ' + s);
    }
    return '{ ' + parts.join(', ') + ' }';
  }
  return null;
}

const preview = (x) => { let s; try { s = JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v + 'n' : v)); } catch { s = undefined; } s = s === undefined ? String(x) : s; return (s.length > 160 ? s.slice(0, 160) + '…' : s).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' '); };
const access = (name) => (name.startsWith('default.') ? 'M.default[' + JSON.stringify(name.slice(8)) + ']' : 'M[' + JSON.stringify(name) + ']');

/** renderTest({ importPath, cases: [{ survivor, name, args, argsB64, expect, expectB64 }] }) → the suggested test file */
export function renderTest(spec) {
  const s = isObj(spec) ? spec : {}, cases = Array.isArray(s.cases) ? s.cases.filter((c) => isObj(c) && typeof c.name === 'string' && typeof c.argsB64 === 'string' && typeof c.expectB64 === 'string') : [];
  const lines = [
    '// witness suggest: each test below kills a mutant that survived the suite. Every one was checked before it was',
    '// written here: it passes on the real code and fails on the mutant. Read each, give it a real name, keep the ones',
    '// that state what the code must do, and fold them into your own tests.',
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { deserialize } from 'node:v8';",
    'import * as M from ' + JSON.stringify(String(s.importPath || './index.mjs')) + ';',
    "const v = (b) => deserialize(Buffer.from(b, 'base64'));",
    'const shape = ' + shape.toString() + ';',
    'const MAXDEPTH = ' + MAXDEPTH + ', MAXBYTES = ' + MAXBYTES + ', MAXKEYS = ' + MAXKEYS + ';',
    'const hexOf = ' + hexOf.toString() + ';',
    'const call = ' + outcomeSource + ';',
    '',
  ];
  for (const c of cases) {
    const sv = isObj(c.survivor) ? c.survivor : {};
    lines.push('test(' + JSON.stringify('line ' + sv.line + ' (' + sv.mutation + '): ' + c.name + ' on this input') + ', async () => {');
    // written as plain JavaScript when the value can be (short enough to read); otherwise as the exact bytes
    const la = lit(c.args), le = lit(c.expect);
    const A = la !== null && la.length <= 400 ? la : null, E = le !== null && le.length <= 400 ? le : null;
    lines.push('  // the line: ' + preview(sv.snippet));
    if (A === null) lines.push('  // the input: ' + preview(c.args));
    if (E === null) lines.push('  // the real code gives: ' + preview(c.expect));
    lines.push('  assert.deepStrictEqual(await call(' + access(c.name) + ', ' + (A !== null ? A : 'v(' + JSON.stringify(c.argsB64) + ')') + '), ' + (E !== null ? E : 'v(' + JSON.stringify(c.expectB64) + ')') + ');');
    lines.push('});');
  }
  return lines.join('\n') + '\n';
}

/** outcome(fn, args, ms) → { ok: shape } or { threw, message }; a promise is awaited up to ms */
export async function outcome(fn, args, ms = 3000) {
  try {
    let r = fn(...(Array.isArray(args) ? args : []));
    if (r && typeof r.then === 'function') {
      let t;
      r = await Promise.race([r, new Promise((res) => { t = setTimeout(() => res({ '[timeout]': ms }), ms); })]).finally(() => clearTimeout(t));
    }
    return { ok: shape(r) };
  } catch (e) {
    return { threw: e && e.constructor && typeof e.constructor.name === 'string' ? e.constructor.name : typeof e, message: String(e && e.message !== undefined ? e.message : e).slice(0, 200) };
  }
}
const outcomeSource = outcome.toString().replace(/^async function outcome/, 'async function');

export default { shape, same, hints, alts, variants, candidatesFor, pick, lit, renderTest, outcome };
