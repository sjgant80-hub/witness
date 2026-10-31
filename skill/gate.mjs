// gate.mjs — the mutation-gate receipt for kernel.mjs.
//
//   node gate.mjs --witness <path to witness v0.6 witness.mjs>
//       runs `witness mutate kernel.mjs` with no cap (every mutant), against `node --test kernel.test.mjs`,
//       and writes receipts/witness.json: killed / total / survivors, plus the SHA-256 of the kernel, the
//       tests and the witness.mjs that judged them — so anyone can re-run the same gate on the same bytes.
//   node gate.mjs --verify
//       exit 1 unless the committed receipt is clean, uncapped, and names THIS kernel and THESE tests (CI).
//
// witness: https://github.com/sjgant80-hub/witness (tag v0.6, commit f04fe30, one zero-dependency file).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NAME = JSON.parse(readFileSync('package.json', 'utf8')).name;
const RECEIPT = 'receipts/witness.json';
// witness.mjs at the v0.6 tag, as committed: `git show v0.6:witness.mjs | sha256sum`
const WITNESS_V06_SHA256 = '9918297aa5f8fc4e1d26d9e6b25226f56102fdc04f0c634155bfcba1c086ef48';
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
// A Windows checkout with core.autocrlf turns LF into CRLF; hash the instrument with LF line endings so the
// same commit gives the same hash on every machine.
const shaLF = (path) => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
const CAP = 100000;   // no practical cap: a capped run would not be the whole file
const TIMEOUT_MS = 60000;   // per mutant; generous so a slow machine never turns a finished run into a timeout 'kill'

function verify() {
  const r = JSON.parse(readFileSync(RECEIPT, 'utf8'));
  const problems = [];
  if (r.kernelSha256 !== sha('kernel.mjs')) problems.push('the receipt names a different kernel.mjs: re-run the gate');
  if (r.testsSha256 !== sha('kernel.test.mjs')) problems.push('the receipt names a different kernel.test.mjs: re-run the gate');
  if (!r.clean) problems.push(`the receipt is not clean: ${r.survived.length} survivor(s)`);
  if (r.capped) problems.push('the receipt comes from a capped run');
  if (r.witness.sha256 !== WITNESS_V06_SHA256) problems.push('the receipt was not made by witness v0.6');
  if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
  console.log(`✓ ${RECEIPT}: witness v0.6 killed ${r.killed}/${r.total} mutants of kernel.mjs ${r.kernelSha256.slice(0, 12)}…` +
    (r.ignored.length ? `, ${r.ignored.length} reviewed-equivalent baselined` : '') + ' — this kernel, these tests');
}

function gate(witnessPath) {
  // Hash the instrument BEFORE it runs, and refuse anything that is not v0.6: a receipt must name the
  // exact witness that judged the kernel, and a checkout that moved mid-run would make it lie.
  const witnessSha = shaLF(witnessPath);
  if (witnessSha !== WITNESS_V06_SHA256) {
    console.error(`✗ ${witnessPath} is not witness v0.6 (sha256 ${witnessSha.slice(0, 12)}…); check out the v0.6 tag first`);
    process.exit(2);
  }
  const t0 = Date.now();
  const run = spawnSync(process.execPath, [witnessPath, 'mutate', 'kernel.mjs', '--cap', String(CAP), '--timeout', String(TIMEOUT_MS), '--test', process.execPath, '--test', 'kernel.test.mjs'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.stderr.write(run.stderr || '');
  if (!run.stdout) { console.error('witness printed no result'); process.exit(2); }
  const m = JSON.parse(run.stdout);
  if (m.baselineFailed || m.noMutants) { console.error(`✗ witness refused to score: ${m.reason}`); process.exit(1); }
  const receipt = {
    kind: `${NAME}.witness`,
    v: 1,
    witness: { tag: 'v0.6', commit: 'f04fe3047e3d49b98c67713befd5b77182afa0d4', sha256: witnessSha },
    kernel: 'kernel.mjs',
    kernelSha256: sha('kernel.mjs'),
    tests: 'node --test kernel.test.mjs',
    testsSha256: sha('kernel.test.mjs'),
    node: process.version,
    platform: process.platform,
    total: m.total,
    killed: m.killed,
    survived: m.survived,
    ignored: m.ignored,
    capped: m.total >= CAP,
    timeoutMs: TIMEOUT_MS,
    clean: m.clean === true,
    seconds: Math.round((Date.now() - t0) / 1000),
    rerun: 'git clone https://github.com/sjgant80-hub/witness && git -C witness checkout v0.6 && node gate.mjs --witness witness/witness.mjs',
  };
  mkdirSync('receipts', { recursive: true });
  writeFileSync(RECEIPT, JSON.stringify(receipt, null, 1) + '\n');
  console.log(`wrote ${RECEIPT}: ${receipt.killed}/${receipt.total} killed, ${receipt.survived.length} survived, ` +
    `${receipt.ignored.length} baselined · clean=${receipt.clean}`);
  process.exit(receipt.clean ? 0 : 1);
}

const args = process.argv.slice(2);
if (args.includes('--verify')) verify();
else if (args.includes('--witness')) gate(args[args.indexOf('--witness') + 1]);
else { console.error('usage: node gate.mjs --witness <witness.mjs> | --verify'); process.exit(2); }
