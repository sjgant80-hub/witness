import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPositive } from './boundary.mjs';
// THEATRE: never tests the zero boundary, so the `>`→`>=` mutant survives (isPositive(0) flips
// unnoticed). This is exactly the shape of test the audits kept finding.
test('isPositive (weak)', () => {
  assert.equal(isPositive(1), true);
  assert.equal(isPositive(-1), false);
});
