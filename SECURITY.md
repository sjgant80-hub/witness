# Security

## Reporting a vulnerability

Report it privately through the supplier, AI Native Solutions, at https://www.ai-nativesolutions.com (contact
through that site). Please do not open a public issue or pull request for it. Say which tag or commit you ran, what
you ran it on, and the smallest input that shows the problem.

Response times, support and any warranty are agreed per deployment; the MIT licence itself carries no warranty.

## What is in scope

- `witness.mjs` and `runner.mjs` (the gate), `ci.mjs`, `witness-bench.mjs` and `action.yml` (the Action), and
  `vendor/proof-of-play/filter.mjs` (verify).
- The optional verify server under `server/`.

A mutant that survives in your code, or a verdict you disagree with, is not a vulnerability: open an ordinary issue,
with the receipt.

## What the gate does on your machine

It reads the source files you name, writes one mutant at a time into your working copy (with an atomic backup
beside it, restored in a `finally`), and runs your own test command under `runner.mjs`. It makes no network call and
uses only Node's built-in modules. Your test command does whatever your tests already do; run the gate where you
already run those tests.

## Supported versions

The latest tag. Pin an exact tag, or the commit it points to; the receipt fingerprints the gate, so a moving
reference would move your anchor.
