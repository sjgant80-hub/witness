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
