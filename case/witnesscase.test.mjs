// case/witnesscase.test.mjs — the cost case on the page is this kernel, imported as is, so these tests are the page's
// numbers. Every expected figure below was worked by hand from the vendored basis (see the comments) and then pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { witnessCase, over, sourcesOf, DEFAULTS, BASIS_KEYS } from './witnesscase.mjs';

const BASIS_PATH = fileURLToPath(new URL('../vendor/sovereign-enterprise/basis.json', import.meta.url));
const RAW = readFileSync(BASIS_PATH);
const B = JSON.parse(RAW.toString('utf8'));

test('the vendored basis is byte for byte the sourced file (sovereign-enterprise data/basis.json)', () => {
  assert.equal(createHash('sha256').update(RAW).digest('hex'), '83e9c2effa2f81596dcfa7110f030940032c1910cdf928d27d628ae59d73bb42');
});

test('the defaults give the figures worked by hand from the basis', () => {
  // wage 19.67/h, CPI 0.031, 24.51p/kWh, 15 W, $2 in / $10 out per million tokens, 0.75396 GBP per USD
  const r = witnessCase(B);
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs, { ...DEFAULTS });
  assert.equal(r.lines.staff, 10228.4);      // 10 h x 52 x 19.67
  assert.equal(r.lines.takenOff, 5114.2);    // half of it
  assert.equal(r.lines.api, 117.62);         // 50 x 52 x (20,000 x 2 + 2,000 x 10) / 1e6 x 0.75396
  assert.equal(r.lines.power, 1.91);         // 10 h x 52 x 15 W / 1000 x 24.51p / 100
  assert.deepEqual(r.perYear, { today: 10228.4, cloudModel: 5231.82, witness: 5116.11 });
  assert.deepEqual(r.over, { today: 31646.27, cloudModel: 16187.05, witness: 15829.04 }); // x (1 + 1.031 + 1.031^2)
  assert.equal(r.savingPerYear, 5112.29);
  assert.equal(r.savingOver, 15817.23);
  assert.equal(r.versusCloudPerYear, 115.71);
  assert.equal(r.versusCloudOver, 358.01);
});

test('the reader’s own inputs replace the defaults, and one year carries no inflation', () => {
  const r = witnessCase(B, { reviewHoursPerWeek: 4, share: 0.25, changesPerWeek: 10, tokensIn: 1000, tokensOut: 100, gateHoursPerWeek: 2, years: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, { staff: 4091.36, takenOff: 1022.84, api: 1.18, power: 0.38 });
  assert.deepEqual(r.perYear, { today: 4091.36, cloudModel: 3069.7, witness: 3068.9 });
  assert.deepEqual(r.over, r.perYear);
  assert.equal(r.savingOver, 1022.46);
  assert.equal(r.versusCloudOver, 0.8);
});

test('like for like: the cloud model and the gate are credited with the same share, so they differ only by their bills', () => {
  const r = witnessCase(B, { share: 0.7 });
  assert.equal(r.versusCloudPerYear, Math.round((r.lines.api - r.lines.power) * 100) / 100);
});

test('over() carries a yearly cost across the years, rising by CPI after the first', () => {
  assert.equal(over(100, 0.1, 2), 210);
  assert.equal(over(100, 0, 1), 100);
  assert.equal(over(100, 0.5, 3), 475);      // 100 + 150 + 225
  assert.equal(over(100, 0.1, 0), 0);
});

test('every boundary the inputs allow is accepted, and one step past it is refused', () => {
  const ok = (input) => witnessCase(B, input).ok;
  assert.equal(ok({ reviewHoursPerWeek: 0 }), true);
  assert.equal(ok({ reviewHoursPerWeek: 168 }), true);
  assert.equal(ok({ reviewHoursPerWeek: 168.5 }), false);
  assert.equal(ok({ reviewHoursPerWeek: -1 }), false);
  assert.equal(ok({ share: 0 }), true);
  assert.equal(ok({ share: 1 }), true);
  assert.equal(ok({ share: 1.01 }), false);
  assert.equal(ok({ gateHoursPerWeek: 0 }), true);
  assert.equal(ok({ gateHoursPerWeek: 168 }), true);
  assert.equal(ok({ gateHoursPerWeek: 169 }), false);
  assert.equal(ok({ gateHoursPerWeek: -2 }), false);
  assert.equal(ok({ years: 1 }), true);
  assert.equal(ok({ years: 10 }), true);
  assert.equal(ok({ years: 0 }), false);
  assert.equal(ok({ years: 11 }), false);
  assert.equal(ok({ years: 2.5 }), false);
  assert.equal(ok({ changesPerWeek: 0, tokensIn: 0, tokensOut: 0 }), true);
});

test('each count is checked on its own, so one bad field is enough to refuse', () => {
  for (const k of ['changesPerWeek', 'tokensIn', 'tokensOut']) {
    assert.equal(witnessCase(B, { [k]: -1 }).ok, false, `${k} of -1 was accepted`);
    assert.equal(witnessCase(B, { [k]: Infinity }).ok, false, `${k} of Infinity was accepted`);
    assert.equal(witnessCase(B, { [k]: '5' }).ok, false, `${k} given as text was accepted`);
    assert.equal(witnessCase(B, { [k]: NaN }).ok, false, `${k} of NaN was accepted`);
  }
  assert.match(witnessCase(B, { tokensOut: -1 }).why, /changes and tokens/);
  assert.match(witnessCase(B, { years: 0 }).why, /years/);
  assert.match(witnessCase(B, { share: 2 }).why, /share/);
  assert.match(witnessCase(B, { reviewHoursPerWeek: 200 }).why, /review hours/);
  assert.match(witnessCase(B, { gateHoursPerWeek: 200 }).why, /gate hours/);
});

test('a basis missing any figure the case reads is refused, not guessed', () => {
  for (const k of BASIS_KEYS) {
    const partial = { ...B };
    delete partial[k];
    const r = witnessCase(partial);
    assert.equal(r.ok, false, `a basis without ${k} still produced a case`);
    assert.match(r.why, /sourced basis/);
  }
  const noOut = { ...B, frontier: { inPerM: 2 } };
  assert.equal(witnessCase(noOut).ok, false);
  assert.equal(witnessCase(null).ok, false);
  assert.equal(witnessCase(undefined, {}).ok, false);
});

test('hostile input never throws: it is refused with a reason', () => {
  const toxic = { get reviewHoursPerWeek() { throw new Error('toxic'); } };
  const r = witnessCase(B, toxic);
  assert.equal(r.ok, false);
  assert.match(r.why, /could not be read/);
  for (const x of [null, undefined, 0, '', [], {}, 10n, () => {}]) assert.equal(typeof witnessCase(x, x).ok, 'boolean');
});

test('every figure is listed with what it is and where it came from', () => {
  const s = sourcesOf(B);
  assert.deepEqual(s.map((x) => x.key), [...BASIS_KEYS]);
  assert.ok(s.every((x) => typeof x.what === 'string' && x.what.length > 0), 'a figure is listed without saying what it is');
  assert.ok(s.every((x) => /^https:\/\//.test(x.source)), 'a figure is listed without a source');
  assert.match(s.find((x) => x.key === 'wageMedianHourly').what, /ONS ASHE/);
  assert.equal(s.find((x) => x.key === 'frontier').what, 'Claude Sonnet 5 (API)');   // a product, not a "what"
  assert.deepEqual(sourcesOf(null), []);
  assert.deepEqual(sourcesOf({}), []);
});
