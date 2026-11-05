// tools/mask-bounds.mjs — the differential run behind two of witness.baseline.json's exemptions, made re-runnable.
//
// The baseline exempts `< → <=` on the loop bounds inside commentMask() as EQUIVALENT: the one extra iteration the
// mutant takes, at i === src.length, writes nothing to the mask. That is argued in the reasons, and this is the check:
// it builds commentMask() from the served witness.mjs as it is, builds one copy per bound with that bound flipped
// (the three `while (i < src.length) {` loops and the line-comment loop), and compares the masks over
//   - every string of length 0 to 6 on the twelve characters the scanner branches on (3,257,437 strings),
//   - 200,000 seeded random strings of length 5 to 24 on the same characters,
//   - every seventh prefix of eight source files in this repo (each truncation leaves the scanner in a different state),
//   - non-string inputs.
// Any differing mask fails the run (exit 1), and so does finding a different number of bounds than the four the
// baseline argues about, so the check cannot quietly stop covering a loop. CI runs it in the `test` job.
//
//   node tools/mask-bounds.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lf = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const src = lf(readFileSync(join(ROOT, 'witness.mjs'), 'utf8'));
const start = src.indexOf('const REGEX_OPENERS');
const end = src.indexOf('// Generate one mutant per operator occurrence');
if (start === -1 || end === -1 || end < start) { console.error('mask-bounds: could not find commentMask() in witness.mjs'); process.exit(2); }
const body = src.slice(start, end).replace('export function commentMask', 'function commentMask');
const build = (code) => new Function(code + '\nreturn commentMask;')();

const LOOP = 'while (i < src.length) {';
const LINE = "while (i < src.length && src[i] !== '\\n') mask[i++] = 1;";
const sites = [];
for (let k = body.indexOf(LOOP); k !== -1; k = body.indexOf(LOOP, k + 1)) sites.push({ at: k, from: LOOP, to: 'while (i <= src.length) {' });
const lk = body.indexOf(LINE);
if (lk !== -1) sites.push({ at: lk, from: LINE, to: LINE.replace('i < src', 'i <= src') });
if (sites.length !== 4) { console.error(`mask-bounds: expected 4 bounds (3 loops + the line-comment loop), found ${sites.length}`); process.exit(2); }

// A control the check must SEE: v0.7's newline stop, inverted so templates stop at a line break and quotes do not.
// If no input tells it apart from the original, the harness is blind and its zeros above mean nothing.
const STOP = "if (src[i] === chr10 && quote !== '`') break;";
const sk = body.indexOf(STOP);
if (sk === -1) { console.error('mask-bounds: could not find the newline stop used as the control'); process.exit(2); }
sites.push({ at: sk, from: STOP, to: STOP.replace('quote !== ', 'quote === '), control: true });

const original = build(body);
const variants = sites.map((s) => build(body.slice(0, s.at) + s.to + body.slice(s.at + s.from.length)));
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const differing = variants.map(() => 0);
let inputs = 0;
const check = (s) => { inputs++; const o = original(s); variants.forEach((v, j) => { if (!same(o, v(s))) differing[j]++; }); };

const ALPHABET = ['/', '*', '\\', '[', ']', '"', "'", '`', '\n', ' ', '(', 'a'];
(function every(prefix, depth) { check(prefix); if (depth === 0) return; for (const c of ALPHABET) every(prefix + c, depth - 1); })('', 6);
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let t = 0; t < 200000; t++) {
  const len = 5 + Math.floor(rnd() * 20);
  let s = '';
  for (let q = 0; q < len; q++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  check(s);
}
for (const f of ['witness.mjs', 'runner.mjs', 'witness-bench.mjs', 'witness.test.mjs', 'ci.mjs', 'server/verify-core.mjs', 'server/payments.mjs', 'case/witnesscase.mjs']) {
  const text = lf(readFileSync(join(ROOT, f), 'utf8'));
  for (let p = 0; p <= text.length; p += 7) check(text.slice(0, p));
}
for (const x of [null, undefined, 0, 1, NaN, {}, [], true]) check(x);

const names = ['outer scanner loop', 'regex loop', 'string loop', 'line-comment loop'];
const control = differing.pop();
console.log(`mask-bounds: ${inputs} inputs; differing masks per flipped bound: ${names.map((n, j) => `${n} ${differing[j]}`).join(', ')}`);
console.log(`mask-bounds: control (the newline stop inverted) differs on ${control} inputs`);
if (control === 0) { console.error('mask-bounds: the control was not detected, so this check cannot see a difference at all'); process.exit(2); }
process.exit(differing.some((d) => d > 0) ? 1 : 0);
