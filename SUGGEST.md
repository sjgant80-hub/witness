# witness suggest · a surviving mutant becomes a suggested killing test (pre-registered)

Written and committed **before** the code (2026-11-17). This is Convergence Pass upgrade 2. The pass wants each layer
to run on the inner layer's byproduct; for witness, the byproduct is the survivor list.

## What it does

Today a survivor is a line and an operator. A person turns it into a test by hand.

`witness suggest` runs three steps.

1. **Record.** It runs the project's own tests once on the real code and records every call the tests make to the
   kernel's exported functions, with their arguments.
2. **Search.** For each survivor, it calls the real code and the mutant on the same inputs. The inputs are the
   recorded calls first, then small changes to them (a number ±1, 0, −1, an empty string or list, one item dropped),
   then witness's hostile battery. It looks for the first input where the two give a different answer, or where
   one throws and the other doesn't.
3. **Verify.** It writes that input and the real code's answer as a test. The test is kept only if it **passes on
   the real code and fails on the mutant**, checked by running it. A suggestion that isn't verified is never shown.

It changes nothing in the gate. Verdicts, scores and `clean` are unchanged. It only writes a suggested test file for
a person to read and commit.

## The measurement (fixed now, before the code exists)

**The ground truth is survivors that a person later killed with a test.** The set is every commit in the estate
that meets all three conditions:
- its message mentions survivors;
- it changes test files;
- it changes no kernel source.

The scan on 2026-11-17 found four:

| repo | commit | kernel(s) |
|---|---|---|
| fall-kit | a98efc4 | core/node.mjs |
| fallkard-forge | d15ee24 | png.mjs, forge.mjs, lineage.mjs |
| si-didy-cascade | 10e5185 | the cascade kernel |
| the-dreamer | 178eca0 | dreamer.mjs |

Excluded, with reasons:
- **witness's own commits 23f6036 and c68aa5a.** Gating witness on itself takes 3 or more hours per side, and its
  survivors are in the CLI.
- **estate-attest 932faf5.** It changed the kernel too.
- **fallkard-forge 383a08f.** Its "survival" is cards surviving damage, not mutants.

For each commit K:
- **S0** is the survivors at the commit before K, with that commit's tests and no baseline file.
- **S1** is the survivors at K, with K's tests and no baseline file.
- **Killable** = S0 minus S1: survivors a person showed can be killed, because the source didn't change.
- `suggest` runs at the commit before K. It never sees K's tests.

**Before: 0** survivors get an automatic test today.

**C1 (kept if both hold):**
- verified suggested tests kill **at least half** of the killable survivors, pooled over all four commits;
- **no** suggested test fails on the real code. The verify step enforces this. A broken verify step fails C1.

**Reported alongside, not part of C1:**
- the share per commit;
- survivors in S1 that `suggest` kills. Each one means a person's "equivalent" judgement was wrong, so each is
  checked by hand and reported.
- survivors it can't reach, with why: not an exported function, needs the clock or disk or network, or the call
  isn't recorded.

If C1 fails, the tool stays in the repo, marked failed, with the numbers. Nothing on the page claims it works.

---

## Result (run once, 17 Nov 2026): **C1 FAILED**, 22 of 45 (48.9%), against a bar of half

Run with code 82bf496 (suggest-core gated 132/132). The receipt is `receipts/suggest-measure.json`, and
`tools/suggest-measure.mjs` re-runs it.

| case | survivors before (S0) | killed by a person (killable) | killed by suggest, of those | its tests fail on the real code |
|---|---|---|---|---|
| fall-kit core/node.mjs | 3 | 2 | 0 | — (no test written) |
| fallkard-forge png.mjs | 3 | 2 | 2 | 0 |
| fallkard-forge forge.mjs | 9 | 6 | 1 | 0 |
| fallkard-forge lineage.mjs | 3 | 1 | 0 | — (no test written) |
| the-dreamer dreamer.mjs | 38 | 34 | 19 | 0 |
| **pooled** | **56** | **45** | **22 (48.9%)** | **0** |

The second half of C1 held: no suggested test failed on the real code. The first half missed, by one survivor
(23 were needed). As the seal says, the tool stays here marked failed. Nothing on the page claims it works.

**Not measured:** si-didy-cascade 10e5185. The commit before it had no tests at all, so there was no S0.

**Reported alongside:**
- **One "contradiction", and it is weak.** the-dreamer line 100: the person's equivalence reason holds for every
  well-formed store. Suggest killed the mutant only on a store with no `subjects` key, where the real code and the
  mutant throw different error messages. A real difference, but only on invalid input.
- **Most of the 22 kills check the answer, not an error message.**
- **Why it missed, by kind:**
  - **7 of forge.mjs's 8 misses:** the search found an input where the answers differ, but the test written from it
    did not pass on the real code and fail on the mutant. This is the biggest gap, and it is in writing the test, not
    in finding the input. The likely cause is a value that does not survive the round trip into the test exactly
    (a Buffer, a signature, a CLI's output).
  - **the dreamer's misses:** the kernel changes its store in place, and suggest compares only return values. A changed
    argument is an answer too.
  - **the rest:** callbacks, which cannot be recorded (fall-kit's `check`), and code reached only through a CLI or
    `catch` paths (lineage).
- **The environment, not the tool:** on Windows, `git archive` wrote CRLF line endings by default and one fallkard-forge
  test failed on them. Every reported case ran on LF copies, as CI checks them out.

**What a v2 would change** (each measured on fresh cases, never on these):
1. Write the expected value and the input so they round-trip exactly.
2. Compare the arguments after the call as well as the return value.
3. Record calls made through a CLI's argv.
