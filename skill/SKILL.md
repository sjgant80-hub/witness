---
name: "witness-mutation-gate"
description: "Runs a mutation gate on the user's own code: it flips one operator at a time in a source file, reruns the project's tests, and names every line where the tests still pass, which is test-theatre a real regression would slip through, then returns a re-runnable receipt. Use when the user asks whether their tests actually catch bugs, wants test quality checked beyond line coverage, is about to merge AI-written code or tests, or needs a fuzz check that a parser or validator never throws on hostile input. Deterministic Node.js script (witness v0.6) with no LLM judge and no network."
summary: "Do the tests have teeth? witness flips one operator at a time (> to >=, && to ||, return true to return false) and reruns the suite; every change the tests miss is a line nobody guards. CLEAN or SURVIVORS with a re-runnable receipt. Plus a hostile-input fuzz gate."
version: "1.0.0"
tags: ["mutation-testing", "test-quality", "ci", "code-review", "fuzzing", "deterministic"]
use_cases: ["Check that AI-written tests would actually fail if the code broke", "Find the exact lines a test suite does not guard, with the test that would guard each one", "Give a reviewer a receipt they can re-run to confirm a file is guarded"]
docs_url: "https://sjgant80-hub.github.io/witness/"
---

# witness: do the tests actually catch bugs?

A green test suite only proves the tests pass. witness checks whether they would fail if the code were
wrong. It makes one small change at a time to a source file (a mutant), reruns the project's own tests,
and records whether they noticed:

- **killed:** the tests failed on the mutant. That line is guarded.
- **survived:** the tests still passed. A real bug on that line would ship. This is test-theatre.

The changes it makes, one per run, only where the operator has a space on each side (so `=>` and `>>` are
never touched): `>=`↔`>`, `<=`↔`<`, `>`→`>=`, `<`→`<=`, `===`↔`!==`, `==`→`!=`, `&&`↔`||`,
`return true`↔`return false`, `+ 1`↔`- 1`. Comments are never mutated; string literals are.

## When to use it

- The user asks whether their tests are any good, or would catch a bug.
- Code or tests were written by an AI agent and are about to be merged.
- A function is meant to be tolerant (a parser, a validator, a sanitiser): use the fuzz gate.

Do not use it on generated files, configs or data, and do not use it to judge whether the code is correct:
it judges the tests.

## Before you run it

- Node.js 20 or newer. The script is `scripts/witness-mutation-gate.mjs`: one file, no dependencies, no
  network. Run it unchanged and keep the `.mjs` extension.
- **It edits the file it gates**, one mutant at a time, and restores it after every run (a sidecar
  `<file>.witnessbak` recovers a run that was killed). Make sure the user's work is saved or committed, and
  edit nothing while it runs.
- **It runs the user's test command** once to time it and once per mutant. The command must finish and exit
  non-zero when a test fails. Total time is roughly (mutants + 1) × one run of the suite; `--cap` bounds it.
- Pick behaviour-critical files: logic, validation, money, permissions. Ask the user which file and which
  test command if it is not obvious.

## How to run it

1. Run the gate with a receipt:

   ```
   node scripts/witness-mutation-gate.mjs receipt <source file> [--cap N] [--timeout MS] [--baseline <file>] --test <test command…>
   ```

   For example `--test npm test`, `--test node --test test/price.test.mjs` or `--test npx vitest run`.
   `--cap` is the most mutants to try (default 80). `--timeout` is the bound for one run of the suite in
   milliseconds (default 20000); if the suite takes more than half of it, witness refuses to score and names
   the value to pass.
2. Read the receipt (JSON on stdout; progress goes to stderr). `verdict` is one of:
   - `CLEAN`: every mutant was killed (exit 0);
   - `SURVIVORS`: `survived` lists each surviving mutant's `line`, `mutation` and `snippet` (exit 1);
   - `GATE_DID_NOT_RUN`: the unmutated suite failed, or was too slow for the bound; `reason` says which (exit 1);
   - `NOTHING_TESTED`: the file has no operator witness can change (exit 1).
3. For each survivor, find the input on which the original and the mutated line disagree, and propose the test
   that checks it. For `n > 0` → `n >= 0` that is `n = 0`. Offer to write those tests, then run the gate again
   until it is CLEAN. Add tests; never change the code under test just to kill a mutant.
4. Report in one line, then the detail: `witness v0.6: <killed> of <total> mutants killed in <file>`, the
   verdict, each survivor, and the receipt's `rerun` command and `fileSha256`. Never present `SURVIVORS`,
   `GATE_DID_NOT_RUN` or `NOTHING_TESTED` as a pass.
5. A survivor that cannot change behaviour (an equivalent mutant) can be recorded, with the user's agreement,
   in a `witness.baseline.json` next to the file: `[{"mutation": "< → <=", "snippet": "<the exact line>",
   "reason": "<why no test can tell them apart, 20 characters or more>"}]`. It is then listed under `ignored`
   and stops counting, but only for that exact line: if the line changes, the entry no longer applies.
6. Fuzz gate: `node scripts/witness-mutation-gate.mjs fuzz ./path/to/module.mjs <exportedFunction>` calls the
   function with a battery of hostile inputs (null, BigInt, a circular object, a toxic getter, a 200,000-element
   array and more) and prints `{ "throwsOn": [...], "neverThrows": true | false }`; exit 0 only if it never throws.

`mutate` is witness v0.6's original command: the same gate, printing the bare result instead of a receipt.
Prefer `receipt`. In v0.6, `mutate` prints a misleading summary line, "0 mutant(s) SURVIVED", when the
unmutated suite is red; its JSON is right (`"baselineFailed": true` and a `reason`).

## What it prints

`examples/theatre-receipt.md` is a full worked example from a real run: `isPositive = n => n > 0` with a suite
that tests 1 and -1 but never 0. The receipt says `"verdict": "SURVIVORS"`, with one survivor at line 3,
`> → >=`. After the test for 0 is added, the same command says `CLEAN`.

## Re-check this skill yourself

Everything here is deterministic: the same file, tests and options give the same mutants and the same verdict,
and no language model judges anything.

- **A receipt:** run its `rerun` command in the same project; the file's SHA-256 must equal `fileSha256`.
- **The engine is witness v0.6:** a receipt's `engine.sha256` is the SHA-256 of `witness.mjs` at the `v0.6` tag
  of https://github.com/sjgant80-hub/witness (`git show v0.6:witness.mjs | sha256sum` gives `9918297a…`). The
  header of the script lists the four mechanical changes that make v0.6 one file, and `skill/build-skill.mjs`
  in that repository rebuilds it from the tag; CI fails if the shipped script differs.
- **Same behaviour as v0.6:** on every push, CI runs v0.6's own test suite against this single file, in a folder
  with no `runner.mjs` (`skill/bundle.test.mjs`): https://github.com/sjgant80-hub/witness/actions/workflows/skill.yml
- **The engine's own mutation gate:** witness gates itself in its own CI. At commit `5a1ffba` (run
  https://github.com/sjgant80-hub/witness/actions/runs/37786178429) the self-gate killed 117 of 127 mutants of
  `witness.mjs`, with the other 10 reviewed as equivalent and baselined with written reasons, and 10 of 10 of
  `runner.mjs`. The engine here is that code without one six-line message branch added after v0.6. On the
  v0.6 tag commit itself the self-gate job was red; it went green through tests added later, not through
  changes to the engine.
- **The receipt layer's mutation gate:** witness v0.6 made 9 single-operator changes (mutants) to
  `skill/kernel.mjs` and its tests caught 9 of them. None was baselined. The receipt is `skill/receipts/witness.json`, for
  kernel SHA-256 `725d9afe464da5faf243cbb91813d3942699cc21fb462d9b5d0e68c9e035ee36`.

## Where it stops

- It judges the tests, not the code. A CLEAN file can still be wrong if the tests assert the wrong thing.
- It changes only the operators listed above, and only with a space on each side. `a>b` is not mutated; a
  missing `if`, a wrong constant or a wrong formula is not a mutant it can make.
- It works on source text, one file per run. The test command can be any runner in any language, as long as it
  exits non-zero on failure.
- Time grows with the number of mutants and the speed of the suite.

---

Made by AI Native Solutions, built by Kar. Powered by the Konomi architecture, created by Thomas Frumkin.
MIT licence: see `LICENSE`.
