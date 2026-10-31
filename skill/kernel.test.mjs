// kernel.test.mjs — the receipt layer (skill/kernel.mjs). witness v0.6 checks that every test bites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, verdictOf, quoteArg, rerunCommand, makeReceipt } from './kernel.mjs';

test('the engine is witness v0.6', () => assert.equal(ENGINE, 'witness v0.6'));

test('verdictOf: nothing tested and a red or unbounded baseline are never a pass', () => {
  assert.equal(verdictOf({ clean: true }), 'CLEAN');
  assert.equal(verdictOf({ clean: false }), 'SURVIVORS');
  assert.equal(verdictOf({ clean: 'yes' }), 'SURVIVORS');
  assert.equal(verdictOf({ clean: true, noMutants: true }), 'NOTHING_TESTED');
  assert.equal(verdictOf({ clean: true, baselineFailed: true }), 'GATE_DID_NOT_RUN');
  assert.equal(verdictOf({ clean: false, noMutants: true, baselineFailed: true }), 'NOTHING_TESTED');
});

test('quoteArg: plain arguments as they are, anything a shell would split or expand in JSON quotes', () => {
  assert.equal(quoteArg('src/thing.mjs'), 'src/thing.mjs');
  assert.equal(quoteArg('--test'), '--test');
  assert.equal(quoteArg('C:/a/b.mjs'), 'C:/a/b.mjs');
  assert.equal(quoteArg('my file.mjs'), '"my file.mjs"');
  assert.equal(quoteArg('$HOME'), '"$HOME"');
  assert.equal(quoteArg(''), '""');
});

test('rerunCommand: the same gate, flag for flag', () => {
  assert.equal(rerunCommand({ file: 'src/a.mjs' }), 'node witness-mutation-gate.mjs mutate src/a.mjs');
  assert.equal(rerunCommand({ file: 'src/a.mjs', cap: 80, timeout: 60000, baseline: 'wb.json', testCmd: ['node', '--test', 'a test.mjs'] }),
    'node witness-mutation-gate.mjs mutate src/a.mjs --cap 80 --timeout 60000 --baseline wb.json --test node --test "a test.mjs"');
  assert.equal(rerunCommand({ file: 'a.mjs', cap: 0, testCmd: [] }), 'node witness-mutation-gate.mjs mutate a.mjs --cap 0');
});

test('makeReceipt: every field, from a clean run', () => {
  const result = { total: 10, killed: 9, survived: [], ignored: [{ mutation: '< → <=', snippet: 'x', reason: 'r' }], clean: true, capped: false };
  assert.deepEqual(makeReceipt({
    file: 'src/a.mjs', fileSha256: 'f'.repeat(64), testCmd: ['npm', 'test'], cap: 80, result,
    engineSha256: 'e'.repeat(64), node: 'v20.0.0', platform: 'linux',
  }), {
    kind: 'witness-receipt',
    v: 1,
    engine: { name: 'witness v0.6', sha256: 'e'.repeat(64) },
    file: 'src/a.mjs',
    fileSha256: 'f'.repeat(64),
    test: ['npm', 'test'],
    verdict: 'CLEAN',
    total: 10,
    killed: 9,
    survived: [],
    ignored: [{ mutation: '< → <=', snippet: 'x', reason: 'r' }],
    capped: false,
    reason: null,
    node: 'v20.0.0',
    platform: 'linux',
    rerun: 'node witness-mutation-gate.mjs mutate src/a.mjs --cap 80 --test npm test',
  });
});

test('makeReceipt: a run that did not happen keeps its reason; missing lists and flags default safely', () => {
  const r = makeReceipt({ file: 'a.mjs', result: { total: 0, killed: 0, survived: [], clean: false, baselineFailed: true, reason: 'the suite is red', capped: 'no' } });
  assert.equal(r.verdict, 'GATE_DID_NOT_RUN');
  assert.equal(r.reason, 'the suite is red');
  assert.deepEqual(r.ignored, []);
  assert.equal(r.capped, false);
  assert.equal(r.test, null);
  assert.equal(makeReceipt({ file: 'a.mjs', result: { capped: true, survived: [] } }).capped, true);
});
