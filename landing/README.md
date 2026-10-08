# The landing — witness on external code

This is the rail **landed on a real, external codebase** — code nobody in this org wrote. It is the
un-forgeable proof that witness works outside its own repo: a deterministic verdict on a third party's
source, reproduced on GitHub's runner, anchored by a hash.

## Subject

- **Library:** [vercel/ms](https://github.com/vercel/ms) — MIT, ~250M downloads/week.
- **Pinned commit:** `1c6264b795492e8fdecbc82cb8802fcfbfc08d26` (v2.1.3).
- **Used unmodified** as an external test subject. All credit to its authors; witness only reads and
  mutates a working copy, restoring it byte-for-byte.

## Adoption

The entire integration is one file dropped into the subject at CI time:

```json
{ "files": ["index.js"], "testCommand": "npx mocha tests.js", "cap": 200, "timeout": 120000 }
```

## Result (`ms-receipt.json`, `ms-verdict.json`)

- **15 / 17 mutants killed**, mutation score **0.882**, **2 survivors**.
- Survivors (unguarded boundaries ms's own 49 tests never pin — *not* bugs, this is the test-theatre
  the gate is designed to find):
  - `index.js:50` — `if (str.length > 100)` — flipping `>`→`>=` survives (no test on length 100 vs 101).
  - `index.js:160` — `var isPlural = msAbs >= n * 1.5` — flipping `>=`→`>` survives (the exact boundary is untested).
- The receipt's `admissible` is therefore `false`: ms's suite is strong but not airtight, and witness
  says exactly where.

## Reproduce it

Deterministic over (ms source + ms tests + witness), so it reproduces anywhere:

```bash
git clone https://github.com/vercel/ms.git && cd ms
git checkout 1c6264b795492e8fdecbc82cb8802fcfbfc08d26
npm install
printf '{"files":["index.js"],"testCommand":"npx mocha tests.js","cap":200,"timeout":120000}' > witness.bench.json
node /path/to/witness/witness-bench.mjs prove .   # -> the same anchor hash as ms-receipt.json
```

Or just dispatch the [`landing` workflow](../../../actions/workflows/landing.yml) — it does all of the
above on a clean GitHub runner and uploads the receipt as an artifact. Same code, same tests, same gate
→ same verdict and same hash. That reproducibility *is* the proof.
