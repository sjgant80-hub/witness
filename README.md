# witness

**▶ Live: https://sjgant80-hub.github.io/witness/** — prove your tests have teeth, and mint a receipt anyone can re-run.
The page explains itself: what it is, START HERE, how it works (traced from the real vercel/ms run), the blueprint with
each organ's CI receipt checked against the file it tested, adoption, a cost case computed from sourced figures, and the
buyer's questions answered.

A **drop-in CI gate** that proves a green suite would actually *catch a regression* — then mints an
un-forgeable, re-runnable **Proof-of-Play** receipt. A mutation gate flips one operator per line and
reruns *your own tests*; a surviving mutant is *test-theatre*. No LLM, no network, zero dependencies.

### Landed on external code

We pointed witness at **[vercel/ms](https://github.com/vercel/ms)** (pinned at `1c6264b`; 724,433,326 npm
downloads in the week 2026-10-29 to 2026-11-04, from [npm's downloads API](https://api.npmjs.org/downloads/point/last-week/ms)
— a library nobody in this org wrote) and ran it against ms's own 49-test suite. The
honest result: **15/17 mutants killed, score 0.882, 2 survivors** — two unguarded boundaries ms's tests
never pin (`index.js:50`, the `> 100` max-input guard; `index.js:160`, the `>= n*1.5` pluralization
boundary). Not bugs — exactly the test-theatre the gate exists to surface. Reproduced on GitHub's runner
by the [`landing` workflow](../../actions/workflows/landing.yml); the receipt's anchor reproduces or it is
refused. See [`landing/`](landing/).

### Verify-as-a-tool (the server, key-ready)

`server/` turns the gate into a tool agents call: REST (`POST /verify`) and MCP (JSON-RPC at `/` —
tools `quote` + `verify_repo`). Hand it a repo pinned to an exact commit; it clones, runs the gate
against the repo's own tests, and returns the receipt **plus the exact steps to reproduce the verdict
without us**. Branch refs are refused (verdicts must reproduce); unknown repos are refused outside
`RUNNER_MODE=container` (running a stranger's tests is running a stranger's code — isolation is the
deployment's job, and the default says so instead of pretending). Payments are a built, tested seam —
Stripe Checkout → `/redeem` → bearer HMAC credit tokens — that stays **honestly inactive** until the
owner sets `STRIPE_SECRET_KEY` + `PRICE_CENTS` + `CREDIT_SECRET`; until then `/verify` is free and the
`/quote` says exactly that. Start: `node server/http.mjs` (defaults to `127.0.0.1:8794`). Its two decision
kernels, `server/verify-core.mjs` and `server/payments.mjs`, are mutation-gated in CI (`server-gate`); `http.mjs`
and `jobs.mjs` are the IO shims around them.

### Add it to your CI in 60 seconds

```jsonc
// witness.bench.json — the whole integration is this one file
{ "files": ["src/index.js"], "testCommand": "npm test" }
```

```yaml
# one step in your workflow (pin the exact tag: the receipt fingerprints the gate, so a moving tag would move the anchor)
- name: witness — proof of play
  uses: sjgant80-hub/witness@v0.7
```

CI now fails on test-theatre and uploads a Proof-of-Play receipt + a step summary + a badge on every run.

## Why it exists

Four adversarial LLM audit passes across our repositories kept surfacing the **same two bug classes**, over and
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

⚑ **Do not run `npx witness`.** The npm name `witness` belongs to an unrelated package by another author; `npx witness`
would download and run that, not this. witness is not published to npm. Take it from this repository at a pinned tag:

```bash
# once: the gate is two zero-dependency files, pinned to a tag
git clone --depth 1 --branch v0.7 https://github.com/sjgant80-hub/witness.git .witness

# mutation gate: mutate a source file, run `npm test` (or the command after --test, given LAST) against each mutant
node .witness/witness.mjs mutate src/thing.mjs
node .witness/witness.mjs mutate src/thing.mjs --cap 40 --timeout 120000 --test node --test test/thing.test.mjs

# fuzz gate: throw the hostile battery at one exported function
node .witness/witness.mjs fuzz src/thing.mjs verifyThing

# a re-runnable Proof-of-Play receipt for the files named in witness.bench.json, and anyone's check of it
node .witness/witness-bench.mjs prove . > receipt.json
PROOF_ASSESSOR=.witness/witness-bench.mjs node .witness/vendor/proof-of-play/filter.mjs verify receipt.json "$PWD"
# (give the repo by its real path: the receipt names the repo folder, and "." has no name to match)
```

Exit code is `0` when the gate is clean and non-zero when it isn't — drop it straight into CI.

As a library:

```js
import { runMutations, fuzz } from './.witness/witness.mjs';

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
function throws. Zero install: the Action runs this repository's own zero-dependency files at the tag you pin
(`witness.mjs`, `runner.mjs`, `witness-bench.mjs`, `ci.mjs` and the vendored proof-of-play `filter.mjs`) against your
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
      - uses: sjgant80-hub/witness@v0.7
        with:
          files: src/gate.mjs src/verify.mjs   # the behaviour-critical files (or commit a witness.bench.json)
          test-command: npm test               # your runner (default: npm test)
          cap: 60                               # optional: max mutants per file
          timeout: 120000                       # optional: per-mutant bound in ms, at least 2x your suite
          fuzz: src/verify.mjs:verify           # optional: module.mjs:exportName fuzz targets
```

A surviving mutant on an AI-generated PR is the point: it means a test named a behaviour it does not
actually guard. The Action turns that into a red check before the code merges.

Every run uploads `witness-receipt.json`, `witness-verdict.json` and `witness-badge.json` as the `witness-proof` artifact,
writes a step summary naming each surviving line, and sets the `badge` and `hash` outputs. This repo's own CI runs the
Action both ways on every push: it must pass a suite that pins the boundary, and it must FAIL a theatre suite and a
function that throws on hostile input (`action-dogfood`).

## What changed in v0.7

- **The CLI starts when it is run through a symlink.** The entry guard compared `import.meta.url` (which Node builds
  from the real path, symlinks followed) with `argv[1]` (the path as typed). Through a symlink they never matched,
  `main()` never ran, and the process exited 0 having printed nothing: a silent green. macOS keeps its temp folder
  behind a symlink; a Windows junction, a symlinked checkout or a package store do the same. Reproduced on this repo
  through a junction, fixed by comparing real paths (`isEntry`), pinned by three tests. `witness-bench.mjs` had the
  same guard and uses the same fix.
- **One masker.** A quoted string cannot cross an unescaped line break in JavaScript, so a quote run that reaches one
  never opened a string: it was a quote inside a regex the scanner could not see (`return /'/.test(s)`). It used to run
  on to the next matching quote, lines later, and turn the file inside out so that a real string holding `//` masked
  live code. It now stops at the line break. The v0.6 masker let quoted runs cross lines, and so did the older copies
  that twelve repositories in this organisation vendor under `.witness/` (each hides the comparison in the test's
  example); this is the one masker they re-vendor, one repository at a time. Measured on 1,197 JavaScript source files
  in thirteen repositories (witness and those twelve) and on vercel/ms's `index.js`, the change alters no mutant site,
  so no existing verdict moves. The baselined loop bounds it touches are re-checked on every push by
  `tools/mask-bounds.mjs`, a differential run with a control it must detect.
- **The Action's `fuzz` input is back.** v0.6 had it; the proof-of-play rewrite dropped it while this README still
  documented it, so named fuzz targets were silently not fuzzed.
- **The landing proves itself monthly.** The `landing` workflow now fails unless the fresh vercel/ms anchor equals the
  committed one, and says whether a mismatch is the gate changing or the result changing (`landing/check.mjs`).
  Its first run under v0.7 said INSTRUMENT CHANGED, because the anchor covers witness.mjs; the verdict was the same
  (15 killed, 2 survived). The landing was re-minted from that run's artifact and the earlier receipt kept, with its
  reason, under `landing/history/`; the next run said REPRODUCED, its receipt byte for byte the committed one
  (see [`landing/`](landing/)).
- **The suite runs on Linux, macOS and Windows.** Until v0.7 CI ran it on Linux only, while the entry-guard fix is
  about macOS's symlinked temp folder and the spawn path has a Windows and a POSIX branch. The `test` job is now a
  matrix of all three.
- **[SECURITY.md](SECURITY.md)** says how to report a vulnerability privately, and what the gate does on your machine.
- **Every CI gate keeps a receipt.** Each gate job writes witness's verdict with the commit, run, runner and the SHA-256
  of every file it covered (`receipts/stamp.mjs`); the receipts are committed under `receipts/ci/` and the live page
  shows a result only while the files it serves still hash the same.

## Survivors that aren't theatre — the baseline

Two kinds of survivor are *not* test-theatre and can never be killed:

- **False positives** — the operator sits inside a **string literal**, so the flip may change no
  behaviour anybody can observe. Read the snippet before believing it.

  ⚑ Comments used to be in that list, and the advice was "dismiss it". That was the tool documenting
  its own defect as your chore. An operator in a comment cannot be killed by any test, because
  changing it changes nothing — so it ALWAYS survived, and a file was reported as test-theatre
  because of a sentence somebody wrote *about* the code. It bit seven of our repositories,
  always the same way: a comment explaining a defect quotes the offending expression, and the
  quotation becomes an unkillable survivor. That left two exits — delete the explanation, or baseline
  the mutant — and the second one trains people to talk the gate out of its verdict, which is the
  exact door `MIN_REASON_CHARS` exists to shut. **An instrument that produces failures nobody can fix
  teaches people to ignore it.** Since v0.4, comments are excluded when mutants are generated.

  String literals are deliberately NOT excluded. Mutating inside a string really does change the
  program — an error message gets asserted on, a pattern gets compiled — so a surviving string mutant
  is weak evidence, but it is evidence. A comment mutant is not evidence of anything, and that is a
  fact about the language rather than a judgement call.
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

- **A run that mutated nothing is not a pass** — a file with no mutable operator returns
  `clean: false`, `score: null`, `noMutants: true`, and the CLI exits non-zero. ⚑ It used to score
  1.0 and report clean, so a mistyped path, a README, or a config file produced a flawless green
  from a gate that tested nothing.
- **The bound must leave room for the suite** — a timed-out run counts as KILLED, so a suite slower
  than `--timeout` makes *every* mutant time out and the gate scores 100% having finished nothing.
  witness times the baseline and refuses when the bound is under `2 ×` an honest run, naming the
  value to pass instead. ⚑ This repo's own suite takes ~2 minutes; against the 20s default it would
  have reported a perfect score from a run in which no test ever completed.
- **A run leaves nothing behind** — the bound is enforced by `runner.mjs`, a supervisor that holds
  the child handle and kills the whole tree while it is still the ancestor. ⚑ `spawnSync`'s own
  timeout signals only the process it started, and that is almost never the one working: `npm test`
  spawns `sh`, which spawns `node`. Killing npm left the grandchildren running. Gating this file on
  a Linux runner leaked **324 processes** and the job was SIGTERMed at 75 minutes without ever
  printing a score; locally it left **301** node processes alive and turned a 3-hour run into a
  5-hour one. Orphans slow the machine, slow runs hit the wall, and a timed-out run orphans more —
  it compounds. With the sweep in place this repo's own suite went from 122s to 58s and leaks
  nothing. (We had this recorded as a Windows quirk. It is not — the runner that died was
  Linux; only the *repair* differs by platform.)
- **The backup is written atomically** — it is what a killed run recovers from, and a half-written
  one is worse than none because the recovery applies it. ⚑ A truncated backup used to be copied
  straight over the source: the recovery path was the corruption path. An empty backup is now
  refused with an explanation rather than restored.
- **Comments are not code** — `commentMask()` scans the source (rather than regexing it, because `//`
  inside a string and an apostrophe inside prose both defeat a regex, and a masker that gets those
  wrong hides real code instead of noise) and no mutant is generated inside a comment.
- **Spaced operators only** (`' > '`, not `'>'`) so mutation never mis-hits `=>`, `>=` inside `===`, or a
  bit-shift.
- **Single-point mutations** — one operator flipped per mutant, so a surviving mutant names an exact line.
- **Per-mutant timeout** — a mutant that breaks termination (flip `lo < hi` → `lo <= hi` in a binary
  search) would otherwise hang the gate forever; it times out and counts as *killed* (the suite could not
  survive it). Default 20s, `opts.timeout`.
- **Always restores** the source file in a `finally`, and **self-heals** from a sidecar after a hard kill.
- **Async-aware fuzz** — awaits the function, so an `async` throw is still caught.

Zero dependencies. Deterministic. MIT.

## Use it from an agent: the witness-mutation-gate skill

`skill/` packages witness v0.6 as an agent skill in the open SKILL.md format (Claude Code, Codex CLI, Cursor and
others read it), for the Agensi skill marketplace. The skill script is one file,
`skill/scripts/witness-mutation-gate.mjs`, because a skill script runs on its own: `skill/build-skill.mjs` builds
it from the `v0.6` tag (witness.mjs and runner.mjs, pinned by SHA-256) with four mechanical changes listed in its
header, and adds a `receipt` command that prints a re-runnable receipt for one gate run.

- `skill/bundle.test.mjs` runs v0.6's own test suite against the one-file script, in a folder with no runner.mjs.
- The receipt layer (`skill/kernel.mjs`) is mutation-gated by witness v0.6: `skill/receipts/witness.json`.
- `.github/workflows/skill.yml` re-checks all of it on every push and builds the Agensi ZIP
  (`node skill/make-zip.mjs`, run from `skill/`), printing its SHA-256.

## Supplier, support and licence

Supplied by AI Native Solutions (https://www.ai-nativesolutions.com — contact through that site). Support, SLA,
warranty and liability are agreed per deployment. MIT licence: the gate is two zero-dependency files you keep, and it
keeps running without us.

Powered by the Konomi architecture, created by Thomas Frumkin. MIT licence.
