// kernel.mjs — the receipt layer of the witness-mutation-gate skill. It turns one run of the witness v0.6
// mutation gate into a receipt that says what was gated, by which engine, with what result, and the exact
// command that re-runs it. Pure: no I/O. build-skill.mjs appends it, unchanged, after the v0.6 engine in the
// single-file skill script, and it is mutation-gated on its own (receipts/witness.json).
export const ENGINE = 'witness v0.6';

// A run that tested nothing, or whose own suite was red or too slow to bound, is never a pass.
export function verdictOf(result) {
  if (result.noMutants) return 'NOTHING_TESTED';
  if (result.baselineFailed) return 'GATE_DID_NOT_RUN';
  return result.clean === true ? 'CLEAN' : 'SURVIVORS';
}

// Quote an argument only when a shell would split or expand it.
export function quoteArg(s) {
  return /^[\w./:@%+=,-]+$/.test(s) ? s : JSON.stringify(s);
}

export function rerunCommand(o) {
  const parts = ['node', 'witness-mutation-gate.mjs', 'mutate', quoteArg(o.file)];
  if (o.cap !== undefined) parts.push('--cap', String(o.cap));
  if (o.timeout !== undefined) parts.push('--timeout', String(o.timeout));
  if (o.baseline !== undefined) parts.push('--baseline', quoteArg(o.baseline));
  if (o.testCmd && o.testCmd.length) parts.push('--test', ...o.testCmd.map(quoteArg));
  return parts.join(' ');
}

export function makeReceipt(o) {
  const r = o.result;
  return {
    kind: 'witness-receipt',
    v: 1,
    engine: { name: ENGINE, sha256: o.engineSha256 },
    file: o.file,
    fileSha256: o.fileSha256,
    test: o.testCmd || null,
    verdict: verdictOf(r),
    total: r.total,
    killed: r.killed,
    survived: r.survived,
    ignored: r.ignored || [],
    capped: r.capped === true,
    reason: r.reason || null,
    node: o.node,
    platform: o.platform,
    rerun: rerunCommand(o),
  };
}
