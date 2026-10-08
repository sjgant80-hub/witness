// ci.mjs — the witness Action's entry: run the gate on the consuming repo ONCE, mint a re-runnable
// Proof-of-Play receipt, publish a step summary + a shields badge, and fail the build if the tests
// don't have teeth. All the logic lives in witness-bench.mjs (pure, mutation-gated); this file is the
// thin IO shim that reads the CI environment and writes the artifacts. Zero dependencies.
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { assess, mintReceipt, summaryMarkdown, badgeEndpoint, headline } from './witness-bench.mjs';

const ws = resolve(process.env.GITHUB_WORKSPACE || process.cwd());

// Config precedence: the repo's own witness.bench.json (the adoption file) wins; otherwise synthesize
// one from the Action inputs passed through the environment. Either way the gate runs the repo's tests.
let config;
if (!existsSync(join(ws, 'witness.bench.json'))) {
  const files = (process.env.WITNESS_FILES || '').split(/\s+/).filter(Boolean);
  if (files.length === 0) {
    console.error('witness: no witness.bench.json in the repo and no `files` input — nothing to gate.');
    process.exit(2);
  }
  config = {
    files,
    testCommand: (process.env.WITNESS_TEST || 'npm test').trim(),
    cap: Number(process.env.WITNESS_CAP) || 80,
    timeout: Number(process.env.WITNESS_TIMEOUT) || 600000,
  };
}

let v;
try { v = assess(ws, { config }); }
catch (e) { console.error(`witness: ${String(e.message || e)}`); process.exit(2); }

const repo = basename(ws.replace(/[\\/]+$/, ''));
writeFileSync('witness-receipt.json', JSON.stringify(mintReceipt(v, repo), null, 2));
writeFileSync('witness-verdict.json', JSON.stringify(v, null, 2));
writeFileSync('witness-badge.json', JSON.stringify(badgeEndpoint(v), null, 2));

const md = summaryMarkdown(v, { repo, sha: process.env.GITHUB_SHA || '' });
if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch { /* summary is best-effort */ } }

console.error('\n' + headline(v));
console.error('wrote witness-receipt.json · witness-verdict.json · witness-badge.json');
process.exit(v.badge ? 0 : 1);
