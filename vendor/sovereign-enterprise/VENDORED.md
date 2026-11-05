# Vendored: the sourced cost basis

`basis.json` is copied byte for byte from
[sjgant80-hub/sovereign-enterprise](https://github.com/sjgant80-hub/sovereign-enterprise) `data/basis.json`
(git blob `8fe2e392afe1be3c8d430225b0786984ba0854ef`, SHA-256
`83e9c2effa2f81596dcfa7110f030940032c1910cdf928d27d628ae59d73bb42`), the same file Liveware vendors for its own
cost case. Every external figure in the cost case on the witness page (the wage, inflation, electricity, the
laptop's extra draw, the cloud model's token price and the exchange rate) is read from it, each with the source
URL it carries. `case/witnesscase.test.mjs` fails if this copy drifts from that hash.

Do not edit it here. If a figure is out of date, it is updated in sovereign-enterprise and re-vendored.
