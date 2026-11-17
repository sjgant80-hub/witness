import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serialize, deserialize } from 'node:v8';
import { shape, same, hints, alts, variants, candidatesFor, pick, lit, renderTest, outcome } from './suggest-core.mjs';
import { inputsFor, record, suggest } from './suggest.mjs';
import { mutants, hostileInputs } from './witness.mjs';

// ── shape: a plain copy that can be compared and stored ─────────────────────────
test('shape keeps primitives as they are, NaN and -0 and bigint included', () => {
  for (const x of [null, undefined, 0, -0, 1.5, NaN, 'a', '', true, false, 10n]) assert.ok(Object.is(shape(x), x));
});
test('shape names functions and symbols instead of keeping them', () => {
  function f(a, b) { return a + b; }
  assert.equal(shape(f), '[function f/2]');
  assert.equal(shape(() => 1), '[function anonymous/0]');
  assert.equal(shape(Symbol('k')), '[symbol k]');
});
test('shape tags Date, RegExp, Error, bytes, Map, Set and promises', () => {
  assert.equal(shape(new Date(0)), '[date 1970-01-01T00:00:00.000Z]');
  assert.equal(shape(new Date(NaN)), '[date invalid]');
  assert.equal(shape(/a+/g), '[regexp /a+/g]');
  assert.deepEqual(shape(new TypeError('bad')), { '[error]': 'TypeError', message: 'bad' });
  assert.equal(shape(new Uint8Array([1, 255])), '[bytes 01ff]');
  assert.equal(shape(new Uint8Array([1, 2, 3]).subarray(1)), '[bytes 0203]');
  assert.equal(shape(new Uint8Array([7]).buffer), '[bytes 07]');
  assert.equal(shape(new Uint8Array(4097)).length, '[bytes '.length + 8192 + '…4097]'.length);
  assert.ok(shape(new Uint8Array(4096)).endsWith('00]'));
  assert.deepEqual(shape(new Map([['a', new Set([1])]])), { '[map]': [['a', { '[set]': [1] }]] });
  assert.equal(shape(Promise.resolve(1)), '[promise]');
});
test('shape copies arrays and objects deeply, marks a cycle and a throwing getter', () => {
  const o = { a: [1, { b: 2 }] }; o.self = o;
  assert.deepEqual(shape(o), { a: [1, { b: 2 }], self: '[circular]' });
  const g = { ok: 1, get bad() { throw new Error('no'); } };
  assert.deepEqual(shape(g), { ok: 1, bad: '[throws]' });
  const shared = { n: 1 };
  assert.deepEqual(shape([shared, shared]), [{ n: 1 }, { n: 1 }], 'the same object twice is not a cycle');
});
test('shape stops at depth 40 and never throws', () => {
  let deep = 0; for (let i = 0; i < 60; i++) deep = { d: deep };
  let s = shape(deep), n = 0;
  while (s && typeof s === 'object') { s = s.d; n++; }
  assert.equal(n, 40); assert.equal(s, '[deep]');
  const evil = new Proxy({}, { ownKeys() { throw new Error('x'); } });
  assert.equal(shape(evil), '[unshapeable]');
  assert.doesNotThrow(() => serialize(shape(o2())));
  function o2() { const m = new Map(); m.set(m, m); return { m, f: () => 0, s: Symbol() }; }
});
test('shape keeps the first 2000 items of a list and the first 2000 keys', () => {
  assert.equal(shape(new Array(2001).fill(0)).length, 2000);
  assert.equal(shape(new Array(2000).fill(0)).length, 2000);
  const o = {}; for (let i = 0; i < 2001; i++) o['k' + i] = i;
  assert.equal(Object.keys(shape(o)).length, 2000);
  assert.equal(shape(new Map(Array.from({ length: 2001 }, (_, i) => [i, i])))['[map]'].length, 2000);
  assert.equal(shape(new Set(Array.from({ length: 2001 }, (_, i) => i)))['[set]'].length, 2000);
});

// ── same: two outcomes ──────────────────────────────────────────────────────────
test('same compares returned shapes deeply and exactly', () => {
  assert.equal(same({ ok: { a: [1, 2] } }, { ok: { a: [1, 2] } }), true);
  assert.equal(same({ ok: { a: [1, 2] } }, { ok: { a: [1, 3] } }), false);
  assert.equal(same({ ok: { a: 1 } }, { ok: { a: 1, b: undefined } }), false, 'an extra key is a difference');
  assert.equal(same({ ok: { a: 1, b: 2 } }, { ok: { a: 1, c: 2 } }), false, 'a different key is a difference');
  assert.equal(same({ ok: [1] }, { ok: { 0: 1 } }), false, 'a list is not an object');
  assert.equal(same({ ok: NaN }, { ok: NaN }), true);
  assert.equal(same({ ok: 0 }, { ok: -0 }), false);
  assert.equal(same({ ok: 1 }, { ok: '1' }), false);
  assert.equal(same({ ok: null }, { ok: {} }), false);
  assert.equal(same({ ok: {} }, { ok: null }), false);
});
test('same: a throw equals only the same kind of throw with the same message', () => {
  assert.equal(same({ threw: 'TypeError', message: 'x' }, { threw: 'TypeError', message: 'x' }), true);
  assert.equal(same({ threw: 'TypeError', message: 'x' }, { threw: 'RangeError', message: 'x' }), false);
  assert.equal(same({ threw: 'TypeError', message: 'x' }, { threw: 'TypeError', message: 'y' }), false);
  assert.equal(same({ threw: 'TypeError', message: 'x' }, { ok: undefined }), false);
  assert.equal(same({ ok: undefined }, { threw: 'TypeError', message: 'x' }), false);
  assert.equal(same(null, { ok: 1 }), false); assert.equal(same({ ok: 1 }, 'x'), false);
});

// ── the inputs to try ───────────────────────────────────────────────────────────
test('hints reads the numbers written on a line, once each, not names or decimals inside names', () => {
  assert.deepEqual(hints('if (s.length < 30 || s.length > 400) return 30;'), [30, 400]);
  assert.deepEqual(hints('x >= 0.5 && v2 > 1 && a.b3'), [0.5, 1]);
  assert.deepEqual(hints(null), []);
});
test('alts moves a number across the boundaries the line names first, then ±1, 0, −1, ×2, negated', () => {
  assert.deepEqual(alts(5, [40]), [40, 39, 41, 6, 4, 0, -1, 10, -5]);
  assert.deepEqual(alts(5), [6, 4, 0, -1, 10, -5]);
  assert.deepEqual(alts(5, ['x', 3]), [3, 2, 4, 6, 4, 0, -1, 10, -5]);
});
test('alts gives strings at the boundary lengths, then empty, shorter, cased, padded, doubled', () => {
  assert.deepEqual(alts('ab', [2]), ['xx', 'xxx', 'x', '', 'b', 'a', 'AB', 'ab', ' ab ', 'abab']);
  assert.deepEqual(alts('a', [0]), ['', 'x', '', 'a'.slice(1), '', 'A', 'a', ' a ', 'aa']);
  assert.equal(alts('a', [1.5]).length, 7, 'a non-whole hint is no length');
  assert.equal(alts('a', [-1]).length, 7);
  assert.equal(alts('a', [100001]).length, 7);
  assert.equal(alts('a', [100000]).length, 10);
});
test('alts flips a boolean, fills null and undefined, and leaves other things alone', () => {
  assert.deepEqual(alts(true), [false]);
  assert.deepEqual(alts(null), [0, '', [], {}, undefined]);
  assert.deepEqual(alts(undefined), [0, '', [], {}, null]);
  assert.deepEqual(alts(new Map()), []);
  assert.deepEqual(alts(() => 1), []);
});
test('alts on a list: empty, without the first, without the last, reversed, then each of the first five items changed', () => {
  const a = alts([1, 2]);
  assert.deepEqual(a.slice(0, 4), [[], [2], [1], [2, 1]]);
  assert.deepEqual(a.slice(4), [[2, 2], [0, 2], [0, 2], [-1, 2], [1, 3], [1, 1], [1, 0], [1, -1]]);
  assert.equal(alts([1, 2, 3, 4, 5, 6]).length, 4 + 5 * 4);
  assert.deepEqual(alts([1], [9])[4], [9]);
});
test('alts on a plain object: each of the first ten keys dropped, then its value changed', () => {
  assert.deepEqual(alts({ a: 1, b: true }), [{ b: true }, { a: 2, b: true }, { a: 0, b: true }, { a: 0, b: true }, { a: -1, b: true }, { a: 1 }, { a: 1, b: false }]);
  const big = {}; for (let i = 0; i < 12; i++) big['k' + i] = true;
  assert.equal(alts(big).length, 10 * 2);
  assert.deepEqual(alts({ a: 1 }, [7])[1], { a: 7 });
  assert.deepEqual(alts(Object.create(null)), [], 'not a plain object');
});
test('alts changes a list or object at its own level and one level in, never deeper, so deep input never runs the stack out', () => {
  assert.deepEqual(alts([[1]]).slice(4), [[[]], [[]], [[]], [[1]]], 'one level in: the inner list\'s own changes, not its items\'');
  assert.deepEqual(alts({ a: { b: 1 } }), [{}, { a: {} }]);
  let deep = 0; for (let i = 0; i < 100000; i++) deep = { d: deep };
  assert.doesNotThrow(() => alts(deep)); assert.doesNotThrow(() => variants([deep]));
  let deepl = 0; for (let i = 0; i < 100000; i++) deepl = [deepl];
  assert.doesNotThrow(() => alts(deepl));
});
test('variants changes one argument at a time, never repeats, never returns the call itself, stops at the cap', () => {
  const v = variants([1, 'a']);
  assert.ok(v.length > 5);
  assert.ok(v.every((x) => x.length === 2 && (x[0] === 1 || x[1] === 'a')), 'one change at a time');
  assert.ok(!v.some((x) => x[0] === 1 && x[1] === 'a'), 'not the call itself');
  assert.equal(new Set(v.map((x) => JSON.stringify(x))).size, v.length, 'no repeats');
  assert.equal(variants([1, 2, 3], [], 4).length, 4);
  assert.equal(variants([1, 2, 3], [], 0).length, 0);
  assert.deepEqual(variants([5], [40]).slice(0, 3), [[40], [39], [41]], 'the boundary first');
  assert.deepEqual(variants('nope'), []);
  assert.deepEqual(variants([1], [], 200, () => { throw new Error('unkeyable'); }), []);
  assert.deepEqual(variants([1], [], 200, () => undefined), []);
  assert.ok(variants([0, 0], [], 200).length < alts(0).length * 2, 'two args that give the same variant count once');
});
test('variants: the cap holds in the middle of an argument\'s changes, and the first changes are kept', () => {
  // the content check was suggested by witness suggest on this file's own survivors (line `out.length > cap`)
  assert.deepEqual(variants([5, 5, 5], [], 3), [[6, 5, 5], [4, 5, 5], [0, 5, 5]]);
  assert.equal(variants([5, 5, 5], [], 7).length, 7);
});

// ── the survivors the first gate of this kernel left (15): five witness suggest could not reach, ten it killed only by
// pinning renderTest's whole output (which embeds the kernel's source); each is killed here by what the code must DO ──
test('shape counts depth through a Map, a Set and a list the same as through an object', () => {
  const chain = (wrap) => { let x = 0; for (let i = 0; i < 60; i++) x = wrap(x); return x; };
  const depthOf = (s, step) => { let n = 0; while (s !== '[deep]' && n < 100) { s = step(s); n++; } return n; };
  assert.equal(depthOf(shape(chain((x) => new Map([['k', x]]))), (s) => s['[map]'][0][1]), 40);
  assert.equal(depthOf(shape(chain((x) => new Map([[x, 1]]))), (s) => s['[map]'][0][0]), 40);
  assert.equal(depthOf(shape(chain((x) => new Set([x]))), (s) => s['[set]'][0]), 40);
  assert.equal(depthOf(shape(chain((x) => [x])), (s) => s[0]), 40);
});
test('lit refuses an object nested deeper than 40 as it does a list', () => {
  let deep = 0; for (let i = 0; i < 45; i++) deep = { d: deep };
  assert.equal(lit(deep), null);
  let ok = 0; for (let i = 0; i < 40; i++) ok = { d: ok };
  assert.notEqual(lit(ok), null);
});
test('outcome: an answer that is null, 0 or empty is returned as it is, not mistaken for a promise', async () => {
  assert.deepEqual(await outcome(() => null, []), { ok: null });
  assert.deepEqual(await outcome(() => undefined, []), { ok: undefined });
  assert.deepEqual(await outcome(() => 0, []), { ok: 0 });
  assert.deepEqual(await outcome(() => ({ then: 3 }), []), { ok: { then: 3 } }, 'a then that is not a function is just a key');
});
test('renderTest writes a value of exactly 400 characters as JavaScript, and one of 401 as bytes', () => {
  const s398 = 'x'.repeat(398), s399 = 'x'.repeat(399);   // lit('x' * n) is n + 2 characters with its quotes
  const t400 = renderTest({ cases: [kase({ args: s398, expect: s398 })] }), t401 = renderTest({ cases: [kase({ args: s399, expect: s399 })] });
  assert.match(t400, new RegExp('call\\(M\\["isPositive"\\], "' + s398 + '"\\), "' + s398 + '"\\)'));
  assert.match(t401, /call\(M\["isPositive"\], v\("/); assert.match(t401, /\), v\("/);
});
test('renderTest\'s previews keep 160 characters whole and cut at 161', () => {
  const m = (n) => new Map([['k', 'x'.repeat(n)]]);   // a Map is never plain JavaScript, so the input is previewed
  const p = (n) => renderTest({ cases: [kase({ args: [m(n)], expect: { ok: 1 } })] }).match(/\/\/ the input: (.*)/)[1];
  assert.equal(JSON.stringify([{}]).length, 4);
  const long = (n) => renderTest({ cases: [kase({ args: { m: m(0) }, expect: { ok: 1 }, survivor: { line: 1, mutation: 'x', snippet: 'y'.repeat(n - 2) } })] }).match(/\/\/ the line: (.*)/)[1];
  assert.equal(long(160), '"' + 'y'.repeat(158) + '"');
  assert.equal(long(161), '"' + 'y'.repeat(158) + 'y' + '…');
  assert.equal(p(1), '[{}]');
});
test('alts leaves alone an object that is not plain, even one with keys', () => {
  class P { constructor() { this.a = 1; } }
  assert.deepEqual(alts(new P()), []);
  const bare = Object.create(null); bare.a = 1;
  assert.deepEqual(alts(bare), []);
});
test('pick wants a string name: an object that only looks like one is refused', () => {
  const sneaky = { startsWith: () => false, toString: () => 'f' };
  assert.equal(pick({ f: () => 1 }, sneaky), null);
});

// ── candidates and names ────────────────────────────────────────────────────────
test('candidatesFor finds the mutants on the survivor\'s line with its operator, and only those', () => {
  const src = 'export const f = (a, b) => a > 0 && b > 0;\nexport const g = (a) => a > 1;\n';
  const ms = mutants(src);
  const c = candidatesFor(ms, { line: 1, mutation: '> → >=' });
  assert.equal(c.length, 2); assert.ok(c.every((m) => m.line === 1 && m.from === '>'));
  assert.equal(candidatesFor(ms, { line: 2, mutation: '> → >=' }).length, 1);
  assert.equal(candidatesFor(ms, { line: 1, mutation: '&& → ||' }).length, 1);
  assert.equal(candidatesFor(ms, { line: 3, mutation: '> → >=' }).length, 0);
  assert.deepEqual(candidatesFor(null, {}), []); assert.deepEqual(candidatesFor(ms, null), []);
  assert.deepEqual(candidatesFor([null, ...ms], { line: 2, mutation: '> → >=' }).length, 1);
});
test('pick finds a named export or a default object\'s function, never a class or a non-function', () => {
  const ns = { f: () => 1, n: 3, K: class {}, default: { g: () => 2, h: 4 } };
  assert.equal(pick(ns, 'f'), ns.f);
  assert.equal(pick(ns, 'default.g'), ns.default.g);
  assert.equal(pick(ns, 'default.h'), null);
  assert.equal(pick(ns, 'n'), null);
  assert.equal(pick(ns, 'K'), null);
  assert.equal(pick({ default: () => 5 }, 'default')(), 5);
  assert.equal(pick({ default: null }, 'default.x'), null);
  assert.equal(pick(null, 'f'), null); assert.equal(pick(ns, 7), null);
  assert.equal(pick({ get f() { throw new Error('x'); } }, 'f'), null);
});

// ── lit: plain JavaScript for a value ───────────────────────────────────────────
test('lit writes values exactly and refuses what it cannot write', () => {
  for (const x of [undefined, null, true, 0, -0, 1.5, NaN, Infinity, -Infinity, 10n, 'a"b', [1, [2]], { a: { b: [null] } }, [], {}]) {
    const s = lit(x);
    assert.notEqual(s, null);
    assert.ok(Object.is(x, x) && (typeof x !== 'object' || x === null ? Object.is(eval('(' + s + ')'), x) : true));
    assert.deepStrictEqual(eval('(' + s + ')'), x);
  }
  assert.equal(lit(-0), '-0'); assert.equal(lit('x'), '"x"'); assert.equal(lit({ a: 1 }), '{ "a": 1 }'); assert.equal(lit([1, 2]), '[1, 2]');
  assert.equal(lit(new Map()), null); assert.equal(lit(new Date(0)), null); assert.equal(lit(() => 1), null);
  assert.equal(lit([new Map()]), null); assert.equal(lit({ a: new Set() }), null);
  assert.equal(lit(Object.create(null)), null);
  const holey = [1]; holey[3] = 2; assert.equal(lit(holey), null);
  const extra = [1]; extra.k = 2; assert.equal(lit(extra), null);
  assert.equal(lit({ get a() { return 1; } }), null);
  assert.equal(lit({ [Symbol('s')]: 1 }), null);
  assert.equal(lit(JSON.parse('{"__proto__": 1}')), null);
  let deep = 0; for (let i = 0; i < 45; i++) deep = [deep];
  assert.equal(lit(deep), null);
  let ok = 0; for (let i = 0; i < 40; i++) ok = [ok];
  assert.notEqual(lit(ok), null);
});

// ── outcome ─────────────────────────────────────────────────────────────────────
test('outcome returns the shape of the answer, or the kind and message of a throw', async () => {
  assert.deepEqual(await outcome((a, b) => ({ s: a + b }), [1, 2]), { ok: { s: 3 } });
  assert.deepEqual(await outcome(() => { throw new RangeError('far'); }, []), { threw: 'RangeError', message: 'far' });
  assert.deepEqual(await outcome(() => { throw 'str'; }, []), { threw: 'String', message: 'str' });
  assert.deepEqual(await outcome(() => { throw null; }, []), { threw: 'object', message: 'null' });
  assert.deepEqual(await outcome(() => { throw { message: undefined }; }, []), { threw: 'Object', message: '[object Object]' });
  assert.deepEqual(await outcome(() => { throw Object.assign(Object.create(null), { message: 'm' }); }, []), { threw: 'object', message: 'm' });
  assert.equal((await outcome(() => { throw new Error('x'.repeat(300)); }, [])).message.length, 200);
  assert.deepEqual(await outcome((...a) => a.length, 'not a list'), { ok: 0 });
});
test('outcome awaits a promise, and gives up on one that never settles', async () => {
  assert.deepEqual(await outcome(async (x) => x * 2, [4]), { ok: 8 });
  assert.deepEqual(await outcome(async () => { throw new TypeError('later'); }, []), { threw: 'TypeError', message: 'later' });
  assert.deepEqual(await outcome(() => new Promise(() => {}), [], 30), { ok: { '[timeout]': 30 } });
  const t0 = Date.now(); await outcome(async () => 1, [], 5000); assert.ok(Date.now() - t0 < 1000, 'a settled promise clears its timer');
});

// ── renderTest ──────────────────────────────────────────────────────────────────
const kase = (o) => ({ survivor: { line: 3, mutation: '> → >=', snippet: 'return n > 0;' }, name: 'isPositive', args: [0], argsB64: serialize([0]).toString('base64'), expect: { ok: false }, expectB64: serialize({ ok: false }).toString('base64'), ...o });
test('renderTest writes one test per case, in plain JavaScript where it can', () => {
  const t = renderTest({ importPath: './boundary.mjs', cases: [kase()] });
  assert.match(t, /import \* as M from "\.\/boundary\.mjs";/);
  assert.match(t, /test\("line 3 \(> → >=\): isPositive on this input"/);
  assert.match(t, /assert\.deepStrictEqual\(await call\(M\["isPositive"\], \[0\]\), \{ "ok": false \}\);/);
  assert.match(t, /\/\/ the line: "return n > 0;"/);
  assert.doesNotMatch(t, /the input:/, 'a plain input needs no preview');
  assert.equal((t.match(/^test\(/gm) || []).length, 1);
});
test('renderTest falls back to the exact bytes for values it cannot write, and says what they are', () => {
  const m = new Map([[1, 2]]);
  const t = renderTest({ importPath: './k.mjs', cases: [kase({ name: 'default.f', args: [m], argsB64: serialize([m]).toString('base64'), expect: { ok: 'x'.repeat(500) }, expectB64: serialize({ ok: 'x'.repeat(500) }).toString('base64') })] });
  assert.match(t, /call\(M\.default\["f"\], v\("/);
  assert.match(t, /\/\/ the input: \[\{\}\]/);
  assert.match(t, /\/\/ the real code gives: \{"ok":"x{150}/);
  assert.match(t, /…/);
});
test('renderTest drops malformed cases, keeps a comment from closing early, and never throws', () => {
  assert.equal((renderTest({ cases: [null, { name: 1 }, kase({ argsB64: 3 }), kase({ expectB64: null }), kase()] }).match(/^test\(/gm) || []).length, 1);
  assert.match(renderTest({ cases: [] }), /from "\.\/index\.mjs"/);
  assert.match(renderTest(null), /from "\.\/index\.mjs"/);
  assert.doesNotMatch(renderTest({ cases: [kase({ survivor: { line: 1, mutation: 'x', snippet: 'a */ b\nc' } })] }), /a \*\/ b/);
  const t = renderTest({ cases: [kase({ survivor: null })] });
  assert.match(t, /line undefined/);
  const big = { ok: 10n }; assert.match(renderTest({ cases: [kase({ expect: { ok: [new Map()], n: 10n }, expectB64: serialize(big).toString('base64') })] }), /"n":"10n"/);
  const cyc = []; cyc.push(cyc);
  assert.match(renderTest({ cases: [kase({ args: cyc, argsB64: 'AAAA' })] }), /the input: /);
});
test('a rendered test runs: it passes where the answer matches and fails where it does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsug-'));
  try {
    writeFileSync(join(dir, 'k.mjs'), 'export const isPositive = (n) => n > 0;\nexport default { neg: (n) => -n };\n');
    writeFileSync(join(dir, 'm.mjs'), 'export const isPositive = (n) => n >= 0;\nexport default { neg: (n) => n };\n');
    const cases = [kase(), kase({ name: 'default.neg', args: [new Map()], argsB64: serialize([2]).toString('base64'), expect: { ok: -2 }, expectB64: serialize({ ok: -2 }).toString('base64') })];
    writeFileSync(join(dir, 'real.test.mjs'), renderTest({ importPath: './k.mjs', cases }));
    writeFileSync(join(dir, 'mut.test.mjs'), renderTest({ importPath: './m.mjs', cases }));
    const run = (f) => spawn(process.execPath, [join(dir, f)]);
    assert.equal(run('real.test.mjs').status, 0);
    const r = run('mut.test.mjs');
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /fail 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
import { spawnSync } from 'node:child_process';
const spawn = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...o });

// ── the orchestrator, end to end on witness's own theatre fixture ───────────────
test('inputsFor: recorded calls first, then their neighbours, then plain hostile inputs, each once', () => {
  const b = (x) => serialize(x).toString('base64');
  const list = inputsFor([['f', b([5])], ['f', b([5])], ['g', 'not base64 of anything']], ['f'], 'if (n > 40)');
  assert.deepEqual(list[0], ['f', b([5])]);
  assert.deepEqual(list[1], ['g', 'not base64 of anything']);
  assert.deepEqual(list.slice(2, 5).map(([, x]) => deserialize(Buffer.from(x, 'base64'))), [[40], [39], [41]]);
  assert.ok(list.some(([n, x]) => n === 'f' && x === b([])), 'no arguments');
  assert.ok(list.some(([n, x]) => n === 'f' && x === b([null])), 'a hostile null');
  assert.ok(!list.some(([, x]) => x.length > 5000), 'no huge inputs');
  assert.equal(new Set(list.map((x) => x.join('\0'))).size, list.length);
  assert.equal(inputsFor([['f', b([5])]], ['f'], '', 3).length, 3);
  assert.equal(inputsFor([], [], '').length, 0);
  const plain = hostileInputs().filter(([, x]) => typeof x !== 'function' && !(typeof x === 'string' && x.length > 1000) && !(Array.isArray(x) && x.length > 1000)).length;
  assert.equal(inputsFor([], ['h'], '').length, 1 + plain - 2, 'no args, then each storable hostile input (a cycle stores; the two toxic ones do not)');
});

test('e2e record: running the tests records the calls they make to the kernel, through a test runner\'s child process', async () => {
  const r = await record('fixtures/boundary.mjs', ['node', '--test', 'fixtures/boundary.theatre.test.mjs']);
  assert.equal(r.testsPassed, true);
  assert.deepEqual(r.fnNames, ['isPositive']);
  assert.deepEqual(r.calls.map(([n, b]) => [n, deserialize(Buffer.from(b, 'base64'))]).sort((a, b) => a[1][0] - b[1][0]), [['isPositive', [-1]], ['isPositive', [1]]]);
  const bad = await record('fixtures/boundary.mjs', ['node', '-e', 'process.exit(3)']);
  assert.equal(bad.testsPassed, false); assert.equal(bad.status, 3); assert.deepEqual(bad.calls, []);
});

test('e2e suggest: the theatre fixture\'s survivor gets a test that passes on the real code and fails on the mutant; the source is never touched', async () => {
  const before = readFileSync('fixtures/boundary.mjs', 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'wsug-e2e-')), out = join(dir, 'out.test.mjs');
  try {
    const r = await suggest('fixtures/boundary.mjs', { survivors: [{ line: 3, mutation: '> → >=', snippet: 'export const isPositive = n => n > 0;' }, { line: 9, mutation: '> → >=', snippet: 'gone' }], testCmd: ['node', '--test', 'fixtures/boundary.theatre.test.mjs'], out });
    assert.equal(readFileSync('fixtures/boundary.mjs', 'utf8'), before);
    assert.equal(r.recorded, 2); assert.equal(r.survivors, 2); assert.equal(r.killed, 1); assert.equal(r.file, out);
    assert.equal(r.report[0].status, 'killed'); assert.deepEqual(r.report[0].tests, ['isPositive']); assert.equal(r.report[0].why, null);
    assert.equal(r.report[1].status, 'none'); assert.match(r.report[1].why, /no mutant on this line/);
    const t = readFileSync(out, 'utf8');
    assert.match(t, /call\(M\["isPositive"\], \[0\]\), \{ "ok": false \}/);
    assert.equal(spawn(process.execPath, [out]).status, 0, 'it passes on the real code');
    writeFileSync('fixtures/boundary.mjs', before.replace('n > 0', 'n >= 0'));
    try { assert.notEqual(spawn(process.execPath, [out]).status, 0, 'it fails on the mutant'); }
    finally { writeFileSync('fixtures/boundary.mjs', before); }
    assert.deepEqual(require_ls('fixtures').filter((f) => f.includes('witness-suggest')), [], 'no mutant or check file is left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); writeFileSync('fixtures/boundary.mjs', before); }
});
import { readdirSync } from 'node:fs';
const require_ls = (d) => readdirSync(d);

test('e2e suggest: an equivalent mutant gets no test, and says why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsug-eq-'));
  try {
    writeFileSync(join(dir, 'k.mjs'), 'export const big = (n) => Math.max(n, 0) >= 0;\n');
    writeFileSync(join(dir, 'k.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { big } from './k.mjs'; test('t', () => assert.equal(big(3), true));\n");
    const r = await suggest('k.mjs', { cwd: dir, survivors: [{ line: 1, mutation: '>= → >', snippet: '' }], testCmd: ['node', '--test', 'k.test.mjs'] });
    assert.equal(r.killed, 1, 'max(n, 0) >= 0 and > 0 differ at n <= 0: not equivalent, so it is killed');
    // the truly equivalent case:
    writeFileSync(join(dir, 'e.mjs'), 'export const one = (n) => (n === n ? 1 : 1);\n');
    writeFileSync(join(dir, 'e.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { one } from './e.mjs'; test('t', () => assert.equal(one(3), 1));\n");
    const e = await suggest('e.mjs', { cwd: dir, survivors: [{ line: 1, mutation: '=== → !==', snippet: '' }], testCmd: ['node', '--test', 'e.test.mjs'] });
    assert.equal(e.killed, 0); assert.equal(e.file, null);
    assert.match(e.report[0].why, /none of the \d+ inputs tried gave a different answer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('e2e suggest: a mutant that loops forever on an input is caught by the bound and still gets its test', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsug-hang-'));
  try {
    writeFileSync(join(dir, 'h.mjs'), 'export function count(n) { let i = 0; while (i < n) i = i + 1; return i; }\n');
    writeFileSync(join(dir, 'h.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { count } from './h.mjs'; test('t', () => assert.equal(typeof count, 'function'));\n");
    const r = await suggest('h.mjs', { cwd: dir, timeout: 5000, survivors: [{ line: 1, mutation: '+ 1 → - 1', snippet: '' }], testCmd: ['node', '--test', 'h.test.mjs'] });
    assert.equal(r.killed, 1, JSON.stringify(r.report));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
