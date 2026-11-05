# The landing — witness on external code

This is the rail **landed on a real, external codebase** — code nobody in this org wrote. It is the
un-forgeable proof that witness works outside its own repo: a deterministic verdict on a third party's
source, reproduced on GitHub's runner, anchored by a hash.

## Subject

- **Library:** [vercel/ms](https://github.com/vercel/ms) — MIT; 724,433,326 npm downloads in the week
  2026-10-29 to 2026-11-04 ([npm's downloads API](https://api.npmjs.org/downloads/point/last-week/ms)).
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
- Minted under witness v0.7 (gate fingerprint `062276a6…`), anchor
  `52dd47c0fa30ae9ae24ad0dbb0337624d10ccad9d3270d8862818be90890e9f8`, by the first landing run under v0.7
  ([run 42040159421](https://github.com/sjgant80-hub/witness/actions/runs/42040159421)). `ms-verdict.json` is that
  run's `witness-verdict.json` byte for byte. Its `witness-receipt.json` differs from `ms-receipt.json` in one field:
  the run cloned the library into a folder named `_ext`, and the receipt records the folder's name as the repo. The
  anchor does not cover that field, so the hash is the same. The workflow now clones into `ms`, the name the earlier
  receipt carried, so every later run's receipt can equal the committed one byte for byte.

## History (`history/`)

The anchor hashes the verdict together with a fingerprint of the gate itself (witness.mjs, the operator set and
the exemption bar), so a changed gate moves the anchor even when the verdict does not. v0.7 changed witness.mjs,
and the first landing run under it said **INSTRUMENT CHANGED** and failed, as `check.mjs` is built to. The
receipt minted under the earlier gate (anchor `69092a4a…`, the same 15 killed and 2 survived) is kept in
`history/` with the reason it was replaced, in `history/index.json`.

## Reproduce it

Deterministic over (ms source + ms tests + witness), so it reproduces anywhere:

```bash
git clone --depth 1 --branch v0.7 https://github.com/sjgant80-hub/witness.git witness
git clone https://github.com/vercel/ms.git ms && cd ms   # the folder name is the repo name the receipt records
git checkout 1c6264b795492e8fdecbc82cb8802fcfbfc08d26
npm install
printf '{"files":["index.js"],"testCommand":"npx mocha tests.js","cap":200,"timeout":120000}' > witness.bench.json
node ../witness/witness-bench.mjs prove . > receipt.json   # the same anchor hash as ms-receipt.json
node ../witness/landing/check.mjs receipt.json ../witness/landing/ms-receipt.json   # REPRODUCED, or why not
```

Or just dispatch the [`landing` workflow](../../../actions/workflows/landing.yml) — it does all of the
above on a clean GitHub runner, fails unless the anchor reproduces, and uploads the receipt as an artifact.
Same code, same tests, same gate → same verdict and same hash. That reproducibility *is* the proof.
