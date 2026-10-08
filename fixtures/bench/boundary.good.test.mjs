import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPositive } from './boundary.mjs';
// tests the BOUNDARY (0), so the `>`→`>=` mutant is caught (isPositive(0) would flip to true)
test('isPositive guards the zero boundary', () => {
  assert.equal(isPositive(1), true);
  assert.equal(isPositive(0), false);
  assert.equal(isPositive(-1), false);
});
