# Worked example: a test suite that looks green but guards nothing

From a real run of `scripts/witness-mutation-gate.mjs` (Node.js v25.7.0 on Windows) on witness v0.6's own
fixtures. The receipt fields `node` and `platform` will differ on your machine; everything else is the same.

## The code

`fixtures/boundary.mjs`, line 3:

```js
export const isPositive = n => n > 0;
```

## The suite under test

`fixtures/boundary.theatre.test.mjs` checks `isPositive(1)` and `isPositive(-1)`, but never `isPositive(0)`.
Every test passes, so the build is green.

## The gate

```
node witness-mutation-gate.mjs receipt fixtures/boundary.mjs --test node --test fixtures/boundary.theatre.test.mjs
```

witness flips `n > 0` to `n >= 0` and runs the suite again. It still passes, so the mutant survives. Exit code 1.

```json
{
  "kind": "witness-receipt",
  "v": 1,
  "engine": {
    "name": "witness v0.6",
    "sha256": "9918297aa5f8fc4e1d26d9e6b25226f56102fdc04f0c634155bfcba1c086ef48"
  },
  "file": "fixtures/boundary.mjs",
  "fileSha256": "25f4bd0d409feec8c7d1229469e2fdd95b50f8659c25ed7a5bd4ba118a181bdf",
  "test": ["node", "--test", "fixtures/boundary.theatre.test.mjs"],
  "verdict": "SURVIVORS",
  "total": 1,
  "killed": 0,
  "survived": [
    { "line": 3, "mutation": "> → >=", "snippet": "export const isPositive = n => n > 0;" }
  ],
  "ignored": [],
  "capped": false,
  "reason": null,
  "node": "v25.7.0",
  "platform": "win32",
  "rerun": "node witness-mutation-gate.mjs mutate fixtures/boundary.mjs --cap 80 --test node --test fixtures/boundary.theatre.test.mjs"
}
```

## What the agent reports

> witness v0.6 found 1 surviving mutant in `fixtures/boundary.mjs`: line 3, `n > 0` can become `n >= 0`
> and every test still passes. Nothing tests `isPositive(0)`. Suggested test:
> `assert.equal(isPositive(0), false)`.

## After the missing test is added

`fixtures/boundary.good.test.mjs` adds `isPositive(0) === false`. The same command with that suite gives
`"verdict": "CLEAN"`, `"killed": 1`, `"total": 1`, exit code 0.
