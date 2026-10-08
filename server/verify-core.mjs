// ════════════════════════════════════════════════════════════════
// server/verify-core.mjs · the PURE kernel of verify-as-a-tool — witness sold to agent buyers
//
// An agent hands us a repository pinned to a commit; we run the mutation gate against that repo's
// own tests and hand back a re-runnable Proof-of-Play receipt. The service practices the thesis it
// sells: every response carries the exact steps to reproduce the verdict WITHOUT us, so the buyer
// never has to trust the seller. No LLM anywhere in the loop.
//
// This file is deliberately IO-free (no network, no fs, no clock reads — callers pass `now`), so the
// mutation gate can verify it exhaustively: request validation, the sha-pinning rule, the allowlist
// decision, the HMAC credit economy, the quote and the 402 challenge. The subprocess work lives in
// jobs.mjs; the HTTP/MCP surface in http.mjs.
//
// KEY-READY, not key-faking: with no STRIPE_SECRET_KEY the service runs in FREE mode and says so.
// Prices are never hardcoded — they exist only when the owner sets PRICE_CENTS in the environment
// (pricing never ships on a public surface; a quote inside a transaction is the one place it may
// appear, and only the owner's env puts it there).
// ════════════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROTOCOL = 'witness-verify/1';

// ── request validation ───────────────────────────────────────────────────────
// A verify request names a repository AND an exact commit. A branch name is refused: the whole point
// is a reproducible verdict, and a moving ref makes the anchor unreproducible by design.
const GIT_HTTPS = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+?(\.git)?$/;
const SHA40 = /^[0-9a-f]{40}$/;

export function parseVerifyRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl.trim() : '';
  const sha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
  if (!GIT_HTTPS.test(repoUrl)) return { ok: false, error: 'repoUrl must be an https git URL on github.com, gitlab.com or codeberg.org' };
  if (!SHA40.test(sha)) return { ok: false, error: 'sha must be a full 40-hex commit — a branch or short ref is refused because the verdict must be reproducible' };
  const req = { repoUrl: repoUrl.replace(/\.git$/, ''), sha };
  // Either the repo carries its own witness.bench.json, or the caller declares what to gate.
  if (body.files !== undefined || body.testCommand !== undefined) {
    if (!Array.isArray(body.files) || body.files.length === 0 || !body.files.every((f) => typeof f === 'string' && f.trim() && !f.includes('..')))
      return { ok: false, error: 'files must be a non-empty array of in-repo paths (no ..)' };
    if (typeof body.testCommand !== 'string' || !body.testCommand.trim())
      return { ok: false, error: 'testCommand must be a non-empty string when files are given' };
    req.files = body.files.map((f) => f.trim());
    req.testCommand = body.testCommand.trim();
  }
  req.cap = Number.isFinite(body.cap) && body.cap > 0 ? Math.min(body.cap, 400) : 200;
  req.timeout = Number.isFinite(body.timeout) && body.timeout > 0 ? Math.min(body.timeout, 600000) : 120000;
  req.install = body.install === true;   // run `npm install --ignore-scripts` first (their devDeps)
  return { ok: true, req };
}

// ── the allowlist decision ───────────────────────────────────────────────────
// Running a stranger's test suite IS running a stranger's code. That is the product, and it is only
// safe inside a throwaway container. So: by default the service gates only repositories on its own
// allowlist (our estate + the public landing subject); RUNNER_MODE=container widens it to any public
// repo, and the deployment README is blunt that this mode belongs in an isolated, disposable runner.
export const DEFAULT_ALLOW = [
  'https://github.com/sjgant80-hub/',
  'https://github.com/vercel/ms',
];

export function allowDecision(req, env = {}) {
  const mode = env.RUNNER_MODE === 'container' ? 'container' : 'allowlist';
  if (mode === 'container') return { allowed: true, mode, why: 'container mode — any public repo, isolation is the deployment’s job' };
  const extra = typeof env.ALLOW_PREFIXES === 'string' ? env.ALLOW_PREFIXES.split(/\s+/).filter(Boolean) : [];
  const list = [...DEFAULT_ALLOW, ...extra];
  const hit = list.find((p) => req.repoUrl === p.replace(/\/$/, '') || req.repoUrl.startsWith(p));
  if (hit) return { allowed: true, mode, why: `allowlisted under ${hit}` };
  return {
    allowed: false, mode,
    why: 'repository is not on the allowlist. This service runs a repo’s own test suite, which is arbitrary code; open mode requires the operator to deploy with RUNNER_MODE=container in an isolated runner. Ask via the contact channel, or run the gate yourself — witness is MIT and the receipt reproduces anywhere.',
  };
}

// ── the credit economy (the payment seam) ────────────────────────────────────
// A credit token is `v1.<credits>.<expiresMs>.<hmac>` — HMAC-SHA256 over the payload with the
// owner's CREDIT_SECRET. Stateless: the server needs no database to honour tokens it minted. Spent
// counts are tracked by the caller handing back the decremented token re-minted by the server, so a
// token is a bearer balance; keep it like cash.
export function mintCreditToken(secret, credits, expiresMs) {
  if (typeof secret !== 'string' || secret.length < 16) return { ok: false, error: 'CREDIT_SECRET must be at least 16 chars' };
  if (!Number.isInteger(credits) || credits <= 0 || credits > 1000000) return { ok: false, error: 'credits must be a positive integer' };
  if (!Number.isInteger(expiresMs) || expiresMs <= 0) return { ok: false, error: 'expiresMs must be a positive integer' };
  const payload = `v1.${credits}.${expiresMs}`;
  const mac = createHmac('sha256', secret).update(payload).digest('hex');
  return { ok: true, token: `${payload}.${mac}` };
}

export function verifyCreditToken(secret, token, nowMs) {
  if (typeof token !== 'string') return { ok: false, error: 'missing credit token' };
  const m = token.match(/^v1\.(\d+)\.(\d+)\.([0-9a-f]{64})$/);
  if (!m) return { ok: false, error: 'malformed credit token' };
  const credits = Number(m[1]), expiresMs = Number(m[2]);
  const payload = `v1.${credits}.${expiresMs}`;
  const want = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(want, 'hex'), b = Buffer.from(m[3], 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'credit token signature does not verify' };
  if (nowMs >= expiresMs) return { ok: false, error: 'credit token expired' };
  if (credits <= 0) return { ok: false, error: 'credit token is spent' };
  return { ok: true, credits, expiresMs };
}

// spend one credit: verify, decrement, re-mint. The caller stores the fresh token.
export function spendCredit(secret, token, nowMs) {
  const v = verifyCreditToken(secret, token, nowMs);
  if (!v.ok) return v;
  const remaining = v.credits - 1;
  if (remaining === 0) return { ok: true, remaining: 0, token: null };
  const re = mintCreditToken(secret, remaining, v.expiresMs);
  return re.ok ? { ok: true, remaining, token: re.token } : re;
}

// ── quote + challenge (what a buyer sees before paying) ──────────────────────
export function paymentsActive(env = {}) {
  return typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY.length > 8
    && Number.isInteger(Number(env.PRICE_CENTS)) && Number(env.PRICE_CENTS) > 0
    && typeof env.CREDIT_SECRET === 'string' && env.CREDIT_SECRET.length >= 16;
}

export function quote(env = {}) {
  if (!paymentsActive(env)) {
    return {
      protocol: PROTOCOL, active: false, free: true,
      note: 'Payments are not active: verification is free within the operator’s allowlist. When the owner activates the rail, this quote will carry the live terms — they are set only by the owner’s environment, never hardcoded.',
      rails: { stripe: 'seam built, awaiting keys', x402: 'seam declared, not implemented' },
    };
  }
  return {
    protocol: PROTOCOL, active: true, free: false,
    currency: (env.PRICE_CURRENCY || 'usd').toLowerCase(),
    unitAmountCents: Number(env.PRICE_CENTS),
    unit: 'one verification run',
    minCredits: 1,
    rails: { stripe: 'active', x402: 'seam declared, not implemented' },
    howToPay: 'POST /pay {credits} -> a Stripe Checkout URL; after paying, POST /redeem {sessionId} -> a bearer credit token; send it as X-Credit-Token on /verify.',
  };
}

// the HTTP 402 body. Speaks the Stripe rail now and declares the x402 seam honestly, so an agent
// that only knows one rail still learns exactly what to do next.
export function paymentChallenge(env = {}) {
  const q = quote(env);
  return {
    status: 402, error: 'payment required',
    quote: q,
    accepts: q.active ? [{ rail: 'stripe-checkout', start: '/pay' }] : [],
    note: q.active ? 'Buy credits, then retry with X-Credit-Token.' : 'Payments are not active yet — if you hit this, it is a bug; /verify should be free right now.',
  };
}

// ── the response shape: the receipt plus the means to distrust us ────────────
export function shapeResult({ receipt, verdict, req, spent }) {
  return {
    protocol: PROTOCOL,
    subject: { repoUrl: req.repoUrl, sha: req.sha },
    verdict: {
      badge: verdict.badge === true,
      mutants: verdict.summary?.mutants ?? null,
      killed: verdict.summary?.killed ?? null,
      survived: verdict.summary?.survived ?? null,
      score: verdict.summary?.score ?? null,
    },
    receipt,
    rerun: {
      note: 'Reproduce this verdict without us — same code, same tests, same gate => the same anchor hash, on your runner.',
      steps: [
        `git clone ${req.repoUrl} subject && cd subject && git checkout ${req.sha}`,
        req.install ? 'npm install --ignore-scripts' : null,
        req.files ? `write witness.bench.json: {"files":${JSON.stringify(req.files)},"testCommand":${JSON.stringify(req.testCommand)},"cap":${req.cap},"timeout":${req.timeout}}` : 'the repo carries its own witness.bench.json',
        'git clone https://github.com/sjgant80-hub/witness && node witness/witness-bench.mjs prove ./subject',
      ].filter(Boolean),
    },
    ...(spent ? { credits: spent } : {}),
    credit: 'Powered by the Konomi architecture, created by Thomas Frumkin.',
  };
}

export default { parseVerifyRequest, allowDecision, mintCreditToken, verifyCreditToken, spendCredit, paymentsActive, quote, paymentChallenge, shapeResult, DEFAULT_ALLOW, PROTOCOL };
