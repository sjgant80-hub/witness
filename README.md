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

## Known limitation

witness mutates source **text**, so an operator that appears inside a comment or string literal produces
a mutant that can't change behaviour — it will always "survive" and show up as a false positive. Read the
survivor's snippet: if the flip is inside a `//` comment or a string, dismiss it. Everything on real code
is signal. (A survivor rate well below 1.0 on audited code is normal and useful — on the estate's own
`fallsieve` it flagged an untested `score < minScore` boundary that four LLM audit passes had left in.)

## Design

- **Spaced operators only** (`' > '`, not `'>'`) so mutation never mis-hits `=>`, `>=` inside `===`, or a
  bit-shift.
- **Single-point mutations** — one operator flipped per mutant, so a surviving mutant names an exact line.
- **Always restores** the source file in a `finally`, even on interrupt.
- **Async-aware fuzz** — awaits the function, so an `async` throw is still caught.

Zero dependencies. Deterministic. MIT.
