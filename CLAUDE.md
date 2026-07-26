# CLAUDE.md — witness

## What this is
A **deterministic build gate**: a mutation-testing pass and a fuzz pass that catch the two bug classes
four LLM audit passes kept finding across the estate — *test-theatre* and *throw-on-malformed*. No LLM,
no network, zero dependencies. Node only.

## Invariants (do not regress)
- **Deterministic.** Same source + same tests ⇒ same verdict, every run. No `Math.random`, no `Date.now`.
- **Spaced operators only.** Mutation pairs are `' > '`, `' && '`, etc. — never bare `'>'` — so we can't
  mis-hit `=>`, the `>=` inside `===`, or a bit-shift. Adding an operator? Keep it spaced and add a case
  to the "never mis-hits" test.
- **Crash-safe.** `runMutations` drops a `*.witnessbak` sidecar before mutating and self-heals from it on
  the next run. `finally` alone is not enough — it does not survive SIGKILL/SIGTERM. Never remove the
  sidecar logic; the `*.witnessbak` glob is git-ignored.
- **Never leak our own test context.** The spawned child runs with `NODE_TEST_CONTEXT` scrubbed
  (`childEnv()`), or a child `node --test` exits 0 on failure and every mutant falsely survives.
- **Always restore.** The source file is byte-identical after a run, on success or on throw.

## Every test is a real incident
`witness.test.mjs` is regression memory. The env-scrub test, the self-heal test, the theatre/real-suite
pair — each pins a bug that actually happened while building witness. Add a test the same way: reproduce
the incident, then fix.

## Run
- `npm test` — the suite (12 tests).
- `node witness.mjs mutate <file>` — mutation gate (exit non-zero ⇒ survivors).
- `node witness.mjs fuzz <module.mjs> <fnName>` — fuzz gate (exit non-zero ⇒ throws on hostile input).

## Do NOT
- Do not run the mutation gate on `witness.mjs` itself via the CLI — it mutates the executing file and,
  if interrupted, cascades into the fixtures. Dogfood on a copy or on the fixtures instead.
- Do not add dependencies. This tool has to run anywhere Node runs.
