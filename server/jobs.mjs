// server/jobs.mjs · the verify tool's IO: clone the pinned commit, run the gate, hand back the
// receipt, leave nothing behind. One job at a time (the busy flag lives in http.mjs) — a gate run
// is CPU-hungry and two at once on one box corrupt each other's timings.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BENCH = fileURLToPath(new URL('../witness-bench.mjs', import.meta.url));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });

export function runVerifyJob(req) {
  const work = mkdtempSync(join(tmpdir(), 'wverify-'));
  try {
    let r = sh('git', ['clone', '--quiet', req.repoUrl + '.git', 'subject'],
      { cwd: work, timeout: 180000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.status !== 0) return { ok: false, error: 'clone failed: ' + String(r.stderr || r.error || '').slice(0, 200) };
    const dir = join(work, 'subject');

    r = sh('git', ['checkout', '--quiet', req.sha], { cwd: dir, timeout: 60000 });
    if (r.status !== 0) return { ok: false, error: 'that exact commit does not exist in the repository — the sha must be real, not asserted' };

    if (req.install) {
      // --ignore-scripts: install their declared devDeps without running their lifecycle hooks.
      // Their code still runs when the gate runs their tests — that is the product, and why open
      // mode is container-only (see verify-core allowDecision).
      r = sh(process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
        { cwd: dir, timeout: 300000, shell: process.platform === 'win32' });
      if (r.status !== 0) return { ok: false, error: 'npm install failed: ' + String(r.stderr || '').slice(-300) };
    }

    if (req.files) {
      writeFileSync(join(dir, 'witness.bench.json'),
        JSON.stringify({ files: req.files, testCommand: req.testCommand, cap: req.cap, timeout: req.timeout }));
    } else if (!existsSync(join(dir, 'witness.bench.json'))) {
      return { ok: false, error: 'the repo carries no witness.bench.json and the request declared no files/testCommand — nothing to gate' };
    }

    r = sh(process.execPath, [BENCH, 'prove', dir], { timeout: 15 * 60 * 1000 });
    let receipt = null;
    try { receipt = JSON.parse(r.stdout); } catch { /* fall through to the honest error */ }
    if (!receipt || !receipt.hash) return { ok: false, error: 'the gate produced no receipt: ' + String(r.stderr || '').slice(-300) };
    return { ok: true, receipt };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* temp dir; the OS will reap */ }
  }
}

// ── the redeemed-session registry: a Checkout session buys credits exactly once ──
const redeemedPath = () => join(process.env.DATA_DIR || process.cwd(), 'redeemed-sessions.jsonl');
export function wasRedeemed(sessionId) {
  try { return readFileSync(redeemedPath(), 'utf8').split('\n').some((l) => l && JSON.parse(l).id === sessionId); }
  catch { return false; }
}
export function markRedeemed(sessionId, credits) {
  appendFileSync(redeemedPath(), JSON.stringify({ id: sessionId, credits, at: new Date().toISOString() }) + '\n');
}

export default { runVerifyJob, wasRedeemed, markRedeemed };
