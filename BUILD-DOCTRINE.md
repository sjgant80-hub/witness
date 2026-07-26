# BUILD-DOCTRINE

What four adversarial audit passes across the estate's engines actually taught us — written down so the
bugs are **designed out of the next build**, not re-fought in the next audit.

The audits found ~71 defects across 9 rapidly-built engines. They converged (23 → 15 → 14 → 19 findings;
severity decaying to zero criticals by pass 4), but two things were clear by the end:

1. The **same handful of failure shapes** kept recurring, build after build.
2. **Fixes themselves introduced ~1–2 new bugs per pass.** An audit you have to re-run is not a gate.

So the discipline is: encode each recurring shape as something a machine checks **before push**, for free,
deterministically. That is what [`witness`](https://sjgant80-hub.github.io/witness/) (the gates) and
[`fallhardened`](https://sjgant80-hub.github.io/fallhardened/) (the primitives) are for. This file is the
*why*.

---

## Law 0 — Elite ≠ correct

`acg-assessor` scores structure: tests exist, README exists, versioned, no obvious smells. A repo can be
**10/10 elite and still wrong**, because a rubric checks that a test *exists*, not that it *would fail if
the behaviour broke*. Every audit finding lived inside an "elite" repo. Structure is necessary and not
sufficient. The gates below check *behaviour*.

---

## The two bug classes (everything reduced to these)

### 1. Test-theatre — a green test that does not guard its behaviour
The archetype, found again and again: a suite for `isPositive` that asserts `isPositive(1)` and
`isPositive(-1)` but never `isPositive(0)`. The day `n > 0` becomes `n >= 0`, every test still passes.

- **Detect:** the **mutation gate**. Flip one operator, re-run the tests. Survivor ⇒ that line is theatre.
- **Concrete estate instances:** fallherd routing tested for "returns a worker" but not "the *same* worker
  on a replica" (routing-by-enrolment-order survived ~70% wrong); attractor "settled vs runaway" tested
  the label but not a DC-offset input that flipped the verdict; konomesh `payloadHash` tested "a hash
  comes back" but not "it binds the *real* content" (a fix once hashed a non-existent field → always
  `sha256('null')`, vacuous, and green).

### 2. Throw-on-malformed — a tolerant function that crashes on hostile input
A `verify`/`classify`/`validate`/`route` documented as returning a safe result, that instead throws on
`null`, `BigInt`, a circular object, a toxic getter, or a 200k-element array.

- **Detect:** the **fuzz gate** — the hostile-input battery. A tolerant function must show `neverThrows`.
- **Concrete estate instances:** verifiers throwing on `BigInt` and circular input; a min/max via spread
  (`Math.max(...arr)`) **stack-overflowing at 200k**; a toxic getter crashing a per-finding read; `null`
  task/`null` minScore silently disabling a gate instead of being rejected.

---

## The primitive catalogue — file the edge off once (`fallhardened`)

Nearly every finding traced to a **hand-rolled primitive re-derived per engine, each re-derivation subtly
wrong**. The fix is not "get it right this time" — it is *stop re-deriving it*. One audited, fuzzed,
mutation-tested implementation, imported everywhere.

| Recurring hand-rolled failure | Primitive |
| --- | --- |
| 32-bit content hash that collided (~65k items) and cross-bound content | `strongHash` (128-bit, object-safe) |
| `String(obj)` → `"[object Object]"`; toxic `toString` crash | `strongHash` / `safeString` |
| verify/validate throwing on malformed input | `guard(fn, fallback)` (async-aware) |
| `localeCompare` ordering seal keys differently per machine | `codeCompare`, `byKey` |
| id disambiguation suffix that re-collided | `uniqueId` (loops until unique) |
| weak/biased ring hash, positions by enrolment order | `unitHash` (FNV-1a + fmix32, identity-derived) |

**Rule:** if you are about to write a hash, a stringify, a comparator, an id-deduper, or a try/catch
boundary — import it from `fallhardened`. If it is not there yet, add it there (with a test that is a real
incident), not inline.

---

## The signature rule — sign what you attribute
Two audits found content that was **attributed but not covered by its signature/hash** (konomesh bound a
worker and artifact *outside* the signed payload → forgeable; fallineage accepted an **all-zeros key + sig
as a valid chain** — a forged provenance with no private key). 

**Rule:** whatever a verify step *claims* (author, content, order, lineage) must be inside the bytes it
hashes/signs, and `verify()` must **re-derive** the claim, not trust a supplied field. Reject small-order
/ all-zero keys before verifying.

---

## The determinism rule — same input, same verdict, everywhere
A gate, a seal, a route, or a classifier that depends on `Math.random`, `Date.now`, iteration/enrolment
order, `localeCompare`, or float spread-vs-offset is not reproducible — and an un-reproducible verdict
cannot be a proof. (fallherd routed by enrolment order; attractor's verdict shifted under a constant DC
offset until it was made translation-invariant.) Derive from **identity and content**, order explicitly,
compare by code unit.

---

## Meta-law — gate the fixes too
Fixes introduced ~1–2 bugs per audit pass (a pass-3 `payloadHash` fix was itself vacuous). A remediation
is a change; run the same gates on it. The point of a deterministic gate is that it costs seconds, so
there is no excuse to skip it after a "small fix".

## Interrupt-safety — a tool that mutates files must be crash-safe
Discovered while dogfooding: `witness` mutates the source under test and restores it in `finally` — but
`finally` **does not survive SIGKILL/SIGTERM**, so a hard-killed run left a live mutant baked into a file.
Any tool that edits files in place must **self-heal**: drop a durable sidecar before mutating and restore
from it on the next run. `finally` is for the happy path and thrown errors, not for `kill -9`.

---

## The pre-push checklist (all deterministic, all seconds)

```bash
npm test                                  # 1. the suite is green
npx witness mutate <each source file>     # 2. no surviving mutants (no test-theatre)
npx witness fuzz <module> <tolerant fn>   # 3. tolerant fns show neverThrows:true
```

Then, by eye / by review:
- [ ] Every primitive (hash, stringify, compare, dedupe-id, try/catch boundary) is imported from
      `fallhardened`, not re-derived inline.
- [ ] Everything a `verify()` attributes is inside the signed/hashed bytes, and `verify()` re-derives it.
- [ ] No verdict depends on `Math.random`, `Date.now`, enrolment/iteration order, or `localeCompare`.
- [ ] Any in-place file mutation self-heals after an interrupt.
- [ ] The tests would go **red** if the behaviour they name broke (that is what the mutation gate proves).

An audit is a language model reading code and guessing. A gate is arithmetic. Prefer the gate.
