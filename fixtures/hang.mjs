// binary search: a `<` → `<=` mutant makes the loop non-terminating (the classic fallherd case).
export function search(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
