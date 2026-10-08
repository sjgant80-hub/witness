# Vendored: proof-of-play

`filter.mjs` and `LICENSE` here are copied verbatim from
[sjgant80-hub/proof-of-play](https://github.com/sjgant80-hub/proof-of-play) (MIT), the estate's
un-forgeable, content-addressed receipt gate. witness is the benchmark; proof-of-play is the gate
that turns a benchmark verdict into a re-runnable **Proof-of-Play** receipt.

It is vendored (not an npm dependency) so the witness Action stays zero-dependency and offline —
the same invariant as witness itself. The benchmark is injected via `PROOF_ASSESSOR` pointing at
`witness-bench.mjs`, which emits proof-of-play's verdict contract
(`{ badge, hash, spec, specFingerprint, summary }`).

Pinned copy. If proof-of-play changes its contract, re-vendor from upstream rather than editing here.
