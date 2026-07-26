# witness

**Live:** [sjgant80-hub.github.io/witness](https://sjgant80-hub.github.io/witness/)

A **deterministic build gate** — catch *test-theatre* and *throw-on-malformed* **before** you push. No
language model, no network, no dependencies. Node only, runs in seconds.

## Why it exists

Four adversarial LLM audit passes across the estate kept surfacing the **same two bug classes**, over and
over, in build after build:

1. **Test-theatre** — a test that stays green even when the behaviour it names is broken. The classic:
   a suite for `isPositive` that checks `isPositive(1)` and `isPositive(-1)` but never `isPositive(0)` —
   so the day someone writes `n >= 0` instead of `n > 0`, every test still passes.
2. **Throw-on-malformed** — a `verify` / `classify` / `validate` function documented as tolerant that
   actually *crashes* on hostile input (`null`, `BigInt`, a circular object, a toxic getter, a 200k-element
   array) instead of returning a safe result.

Auditing for these with an LLM cost ~1.5M tokens per build and still missed some. Both are catchable
**deterministically**, for free:

- **Mutation gate** — flip one operator in the source (`>` → `>=`, `&&` → `||`, `return true` →
  `return false`), then run the project's own tests. If they *still* pass, that line is unguarded. A
  surviving mutant is a hole a real regression falls straight through.
- **Fuzz gate** — throw the hostile-input battery at a function. If it throws, it fails the never-throw
  boundary contract.

## Use it

```bash
# mutation gate: mutate a source file, run `npm test` (or a custom command) against each mutant
npx witness mutate src/thing.mjs
npx witness mutate src/thing.mjs --cap 40

# fuzz gate: throw the hostile battery at one exported function
npx witness fuzz ./src/thing.mjs verifyThing
```

Exit code is `0` when the gate is clean and non-zero when it isn't — drop it straight into CI.

As a library:

```js
import { runMutations, fuzz } from 'witness';

const m = runMutations('src/thing.mjs', { testCmd: ['npm', 'test'] });
// → { total, killed, survived:[{line, mutation, snippet}], score, clean }

const f = await fuzz(verifyThing);
// → { throwsOn:[{input, error}], neverThrows }
```

## The lesson it caught in itself

witness spawns your project's test runner. The first time it ran under its *own* `node --test` suite,
every mutant falsely "survived" — because the spawned `node --test` **inherited `NODE_TEST_CONTEXT`** from
the parent runner and switched to the child-reporter protocol, exiting `0` even on failure. The gate now
scrubs that env var before spawning, and a regression test pins it. A build gate has to be hardened
against the exact bug classes it hunts — this repo is dogfooded on itself.

## Use as a GitHub Action

Drop the gate into any repo's CI — it fails the build when a mutant survives (test-theatre) or a fuzzed
function throws. Zero install: the Action ships `witness.mjs` (one zero-dep file) and runs it against your
project's own tests.

```yaml
# .github/workflows/witness.yml
name: witness
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - uses: sjgant80-hub/witness@v0.2
        with:
          files: src/gate.mjs src/verify.mjs   # the behaviour-critical files
          test-command: npm test               # your runner (default: npm test)
          cap: 60                               # optional: max mutants per file
          fuzz: src/verify.mjs:verify           # optional: module.mjs:exportName fuzz targets
```

A surviving mutant on an AI-generated PR is the point: it means a test named a behaviour it does not
actually guard. The Action turns that into a red check before the code merges.

## Survivors that aren't theatre — the baseline

Two kinds of survivor are *not* test-theatre and can never be killed:

- **False positives** — the operator sits inside a `//` comment or a string literal, so the flip changes
  no behaviour. Read the snippet; if it's in a comment or string, dismiss it.
- **Equivalent mutants** — the mutation is semantically identical to the original (an idempotent
  `max`-assignment, an out-of-bounds write a typed array silently drops, a tie-break branch that's
  unreachable because ids are unique). No test can distinguish them. This is mutation testing's known floor.

So a clean gate is unreachable on most real code — until you **review** the survivors and record the
equivalent ones. Drop a `witness.baseline.json` next to the source:

```json
[
  { "mutation": "< → <=", "snippet": "for (let i = 0; i < s.length; i++) {", "reason": "idempotent OOB write, dropped by the typed array" }
]
```

Baselined survivors are reported as `ignored` (with their reason) and no longer count against `clean`.
Each entry is a signed-off human judgement, matched by the **exact** `(mutation, code-line)` pair — so it
stops applying the instant that line changes. **You cannot baseline away a future bug.**

## Design

- **Spaced operators only** (`' > '`, not `'>'`) so mutation never mis-hits `=>`, `>=` inside `===`, or a
  bit-shift.
- **Single-point mutations** — one operator flipped per mutant, so a surviving mutant names an exact line.
- **Per-mutant timeout** — a mutant that breaks termination (flip `lo < hi` → `lo <= hi` in a binary
  search) would otherwise hang the gate forever; it times out and counts as *killed* (the suite could not
  survive it). Default 20s, `opts.timeout`.
- **Always restores** the source file in a `finally`, and **self-heals** from a sidecar after a hard kill.
- **Async-aware fuzz** — awaits the function, so an `async` throw is still caught.

Zero dependencies. Deterministic. MIT.
