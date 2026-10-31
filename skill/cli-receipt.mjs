// cli-receipt.mjs — the `receipt` command of the skill script. It runs the same gate as v0.6's `mutate` (same
// engine call, same options) and prints a re-runnable receipt instead of the bare result. build-skill.mjs appends
// it after the v0.6 engine and the receipt layer; runMutations, readFileSync and ENGINE_SHA256 come from there.
import { createHash } from 'node:crypto';
import { makeReceipt } from './kernel.mjs';

const RECEIPT_USAGE = 'usage: node witness-mutation-gate.mjs receipt <sourceFile> [--cap N] [--timeout MS] [--baseline <file>] [--test <cmd...>]';

function receiptMode(argv) {
  const [, file, ...rest] = argv;
  if (!file || file.startsWith('--')) { console.error(RECEIPT_USAGE); process.exit(2); }
  const testAt = rest.indexOf('--test');
  const opts = testAt === -1 ? rest : rest.slice(0, testAt);
  const testCmd = testAt === -1 ? undefined : rest.slice(testAt + 1);
  const val = (flag) => { const i = opts.indexOf(flag); return i === -1 ? undefined : opts[i + 1]; };
  const cap = val('--cap') === undefined ? 80 : Number(val('--cap'));
  const timeout = val('--timeout') === undefined ? undefined : Number(val('--timeout'));
  const baseline = val('--baseline');
  if (!(cap > 0) || (timeout !== undefined && !(timeout > 0))) { console.error('witness receipt: --cap and --timeout want positive numbers'); process.exit(2); }
  let source;
  try { source = readFileSync(file); } catch (e) { console.error(`witness receipt: cannot read ${file}: ${e.code || e.message}`); process.exit(2); }
  const fileSha256 = createHash('sha256').update(source).digest('hex');
  console.error(`witness v0.6 · mutation gate: ${file}${testCmd ? ` · tests: ${testCmd.join(' ')}` : ' · tests: npm test'} …`);
  const result = runMutations(file, { cap, testCmd, baseline, timeout });
  const receipt = makeReceipt({
    file, fileSha256, testCmd, cap, timeout, baseline, result,
    engineSha256: ENGINE_SHA256, node: process.version, platform: process.platform,
  });
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(receipt.verdict === 'CLEAN' ? 0 : 1);
}
