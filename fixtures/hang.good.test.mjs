import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from './hang.mjs';
test('search returns the insertion point', () => {
  assert.equal(search([1, 3, 5], 3), 1);
  assert.equal(search([1, 3, 5], 4), 2);
  assert.equal(search([1, 3, 5], 0), 0);
  assert.equal(search([1, 3, 5], 9), 3);
});
