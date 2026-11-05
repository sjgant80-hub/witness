// receipts/stamp.mjs — CI only. Wraps one mutation-gate verdict (witness's own JSON, from stdout) in a receipt that
// says which job ran it, on which commit and runner, with which command, over which exact files. The receipt is
// uploaded as a build artifact and committed verbatim under receipts/ci/, and the live page reads it from there:
// it hashes the files it serves and shows the receipt only as current when every hash still matches, so a gate
// result can never be shown against code it did not test. Line endings are normalised before hashing, because the
// same blob checks out CRLF on Windows and LF everywhere else.
//
//   node receipts/stamp.mjs <name> <verdict.json> "<command>" <file> [more files...]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [name, verdictPath, command, ...files] = process.argv.slice(2);
if (!name || !verdictPath || !command || files.length === 0) {
  console.error('usage: node receipts/stamp.mjs <name> <verdict.json> "<command>" <file> [more files...]');
  process.exit(2);
}
const lf = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const sha = (p) => createHash('sha256').update(lf(readFileSync(p, 'utf8'))).digest('hex');
const env = process.env;
const receipt = {
  receipt: 'witness-ci-gate',
  name,
  command,
  commit: env.GITHUB_SHA || null,
  run: {
    id: env.GITHUB_RUN_ID || null,
    attempt: env.GITHUB_RUN_ATTEMPT || null,
    url: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    workflow: env.GITHUB_WORKFLOW || null,
    job: env.GITHUB_JOB || null,
  },
  runner: { os: env.RUNNER_OS || process.platform, node: process.version },
  inputs: files.map((p) => ({ path: p, sha256: sha(p) })),
  verdict: JSON.parse(readFileSync(verdictPath, 'utf8')),
};
mkdirSync('_receipts', { recursive: true });
writeFileSync(`_receipts/${name}.json`, JSON.stringify(receipt, null, 2) + '\n');
const v = receipt.verdict;
console.log(`receipt ${name}: ${v.killed}/${v.total} killed, ${(v.survived || []).length} survived, ${(v.ignored || []).length} reviewed-equivalent · clean ${v.clean}`);
