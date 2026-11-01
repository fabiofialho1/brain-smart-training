import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceRange } from '../js/chart.js';

test('niceRange rounds outward to multiples of the step', () => {
  assert.deepEqual(niceRange(-1.2, 10.4), { lo: -3, hi: 12, step: 3 });
  assert.deepEqual(niceRange(2.6, 6.1), { lo: 0, hi: 9, step: 3 });
});

test('niceRange never returns a degenerate range', () => {
  const { lo, hi } = niceRange(5, 5);
  assert.ok(hi - lo >= 6);
  assert.ok(lo <= 5 && hi >= 5);
});
