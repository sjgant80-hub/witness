# witness — specification

A build gate is only useful if its verdict is trustworthy. This is the contract.

## Mutation gate — `runMutations(srcPath, opts) → Result`

`opts`: `{ testCmd = ['npm','test'], cwd = process.cwd(), cap = 80, timeout = 20000, baseline }`.
`timeout` bounds each mutant's test run (a mutant that hangs the suite is counted **killed**, never waited
on). `baseline` is a path or array of `{ mutation, snippet, reason }`; if omitted, `witness.baseline.json`
next to the source (or in `cwd`) is auto-loaded.

1. **Self-heal.** If `srcPath + '.witnessbak'` exists (a prior run was hard-killed), restore `srcPath`
   from it and delete the sidecar before doing anything else.
2. Read `srcPath` → `original`. Write `original` to the sidecar (durable truth for step 1 of a *future*
   run, should this one be killed).
3. Enumerate mutants of `original`: for each spaced-operator occurrence **outside a comment**, one
   single-point mutation. Comment regions (`//` to end of line, `/*` to `*/`, unterminated block
   comments to end of file) are found by a character scan that tracks string literals and escapes, so
   a comment marker inside a string does not blind the mutator to real code after it. An operator in a
   comment cannot change behaviour, so such a mutant can never be killed and its survival is not
   evidence about the tests. String literals ARE mutated: a change inside a string changes the
   program, so a surviving string mutant is weak evidence but still evidence.
   Cap at `cap`; record whether the list was capped.
3b. Before any mutant runs, the UNMUTATED suite is run once and timed.
   - non-zero exit ⇒ `baselineFailed` — a red baseline makes every mutant look killed.
   - `baselineMs * 2 > timeout` ⇒ `baselineFailed` — the bound leaves no room for an honest run, so
     every mutant would time out and be counted KILLED, scoring a perfect clean from a gate that
     finished nothing. The refusal names the `--timeout` value to pass.
3c. `srcPath` is copied to `srcPath.witnessbak` **atomically** (temp file, then rename), so the
   sidecar on disk is either absent or complete. On the next run, a backup that is EMPTY while the
   source is not is refused rather than restored — restoring it would destroy the file the sidecar
   exists to protect.
4. For each mutant: write it to `srcPath`, run `testCmd` under `timeout` (child env has
   `NODE_TEST_CONTEXT` scrubbed).
   - child exit `0` ⇒ tests passed ⇒ mutant survived (candidate test-theatre) → checked against the baseline.
   - child exit non-zero, **or a timeout** ⇒ tests did not pass ⇒ **mutant KILLED** (the line is guarded).
   - a surviving mutant whose `(mutation, snippet)` is in the baseline ⇒ **IGNORED** (reviewed-equivalent).
   - **zero mutants** ⇒ `clean: false`, `score: null`, `noMutants: true`. A gate that found nothing
     to mutate has tested nothing, and must not be reported as a pass.
5. `finally`: write `original` back to `srcPath`; delete the sidecar.

`Result`: `{ total, capped, killed, survived[], ignored[], score = killed/total, clean = survived.length === 0 }`.
Each `survived`/`ignored` entry: `{ line, mutation: 'from → to', snippet }` (`ignored` adds `reason`).
`clean` counts only **unreviewed** survivors — baselined equivalents do not block it, but a stale baseline
entry (its code line changed) silently stops matching, so it can never hide a new survivor.

**Guarantees.** Deterministic. `srcPath` byte-identical after the call (normal or thrown). No sidecar
left behind after a clean exit. A SIGKILL between steps 4 and 5 leaves the sidecar, which the next run
consumes — the repo is never silently left holding a mutant.

## Fuzz gate — `fuzz(fn) → { throwsOn[], neverThrows }`

Apply `hostileInputs()` to `fn`, awaiting the result (async-aware). Collect every input that makes `fn`
throw. `neverThrows = throwsOn.length === 0`.

`hostileInputs()` is the battery every audit crash reduced to: `null, undefined, NaN, Infinity, ''`,
whitespace, `[]`, `{}`, `true`, `false`, `BigInt`, a function, a 200k string, a 200k array, a circular
object, a toxic getter, a toxic `toString`, `-1`, `0`, and a deeply nested object.

Use on functions whose contract is *tolerant* (`verify` / `validate` / `classify` / `parse`): a non-empty
`throwsOn` is a contract violation. For functions documented to reject bad input, a non-empty `throwsOn`
is the *expected* signature — the gate reports, the caller judges.

## Operator set
`>= ↔ >`, `<= ↔ <`, `=== ↔ !==`, `== → !=`, `&& ↔ ||`, `return true ↔ return false`, `+1 ↔ -1`.
All spaced. Extending the set MUST preserve the "never mis-hits `=>`/shift/`===`" property.

## Exit codes (CLI)
`0` clean · `1` gate found a problem (survivors / throws) · `2` usage error.
