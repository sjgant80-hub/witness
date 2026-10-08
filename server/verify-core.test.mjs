// server/verify-core.test.mjs — the verify tool's pure kernel, pinned branch by branch. The mutation
// gate runs this suite; every assertion is a mutant's grave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseVerifyRequest, allowDecision, mintCreditToken, verifyCreditToken, spendCredit, paymentsActive, quote, paymentChallenge, shapeResult, DEFAULT_ALLOW } from './verify-core.mjs';

const SHA = 'a'.repeat(40);
const GOOD = { repoUrl: 'https://github.com/vercel/ms', sha: SHA };

// ── parseVerifyRequest ────────────────────────────────────────────────────────
test('a minimal request parses, strips .git, and gets the safe defaults', () => {
  const r = parseVerifyRequest({ repoUrl: 'https://github.com/vercel/ms.git', sha: SHA.toUpperCase() });
  assert.equal(r.ok, true);
  assert.equal(r.req.repoUrl, 'https://github.com/vercel/ms');
  assert.equal(r.req.sha, SHA);                      // lowercased
  assert.equal(r.req.cap, 200);
  assert.equal(r.req.timeout, 120000);
  assert.equal(r.req.install, false);
});
test('a branch name, a short sha, and an off-host URL are each refused', () => {
  assert.equal(parseVerifyRequest({ ...GOOD, sha: 'main' }).ok, false);
  assert.equal(parseVerifyRequest({ ...GOOD, sha: SHA.slice(0, 39) }).ok, false);
  assert.match(parseVerifyRequest({ ...GOOD, sha: 'main' }).error, /reproducible/);
  assert.equal(parseVerifyRequest({ repoUrl: 'https://evil.example/a/b', sha: SHA }).ok, false);
  assert.equal(parseVerifyRequest(null).ok, false);
});
test('files/testCommand travel together, .. is refused, caps clamp', () => {
  assert.equal(parseVerifyRequest({ ...GOOD, files: ['index.js'] }).ok, false);                   // files without testCommand
  assert.equal(parseVerifyRequest({ ...GOOD, files: [], testCommand: 'npm test' }).ok, false);   // empty files
  assert.equal(parseVerifyRequest({ ...GOOD, files: ['../x'], testCommand: 'npm test' }).ok, false);
  const r = parseVerifyRequest({ ...GOOD, files: [' index.js '], testCommand: ' npm test ', cap: 999, timeout: 9e9, install: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.req.files, ['index.js']);
  assert.equal(r.req.testCommand, 'npm test');
  assert.equal(r.req.cap, 400);                      // clamped
  assert.equal(r.req.timeout, 600000);               // clamped
  assert.equal(r.req.install, true);
});

// ── allowDecision ─────────────────────────────────────────────────────────────
test('the allowlist admits the estate and the landing subject, refuses strangers with the container story', () => {
  const ours = parseVerifyRequest({ repoUrl: 'https://github.com/sjgant80-hub/witness', sha: SHA }).req;
  const ms = parseVerifyRequest(GOOD).req;
  const stranger = parseVerifyRequest({ repoUrl: 'https://github.com/someone/else', sha: SHA }).req;
  assert.equal(allowDecision(ours, {}).allowed, true);
  assert.equal(allowDecision(ms, {}).allowed, true);
  const no = allowDecision(stranger, {});
  assert.equal(no.allowed, false);
  assert.equal(no.mode, 'allowlist');
  assert.match(no.why, /container/);
});
test('RUNNER_MODE=container opens all subjects; ALLOW_PREFIXES extends the list', () => {
  const stranger = parseVerifyRequest({ repoUrl: 'https://github.com/someone/else', sha: SHA }).req;
  assert.equal(allowDecision(stranger, { RUNNER_MODE: 'container' }).allowed, true);
  assert.equal(allowDecision(stranger, { ALLOW_PREFIXES: 'https://github.com/someone/' }).allowed, true);
  assert.ok(DEFAULT_ALLOW.some((p) => p.includes('sjgant80-hub')));
});

// ── the credit economy ────────────────────────────────────────────────────────
const SECRET = 's'.repeat(32);
test('mint -> verify round-trips; tampering, expiry, weak secrets and bad counts are refused', () => {
  const exp = 1000000;
  const t = mintCreditToken(SECRET, 3, exp);
  assert.equal(t.ok, true);
  const v = verifyCreditToken(SECRET, t.token, 1);
  assert.equal(v.ok, true);
  assert.equal(v.credits, 3);
  const tampered = t.token.replace(/\.3\./, '.4.');
  assert.equal(verifyCreditToken(SECRET, tampered, 1).ok, false);
  assert.equal(verifyCreditToken(SECRET, t.token, exp).ok, false);        // expired at exactly exp
  assert.equal(mintCreditToken('short', 3, exp).ok, false);
  assert.equal(mintCreditToken(SECRET, 0, exp).ok, false);
  assert.equal(mintCreditToken(SECRET, 2.5, exp).ok, false);
  assert.equal(verifyCreditToken(SECRET, null, 1).ok, false);
});
test('spendCredit decrements and re-mints; the last credit leaves no token', () => {
  const t2 = mintCreditToken(SECRET, 2, 1000000).token;
  const s1 = spendCredit(SECRET, t2, 1);
  assert.equal(s1.ok, true);
  assert.equal(s1.remaining, 1);
  assert.equal(verifyCreditToken(SECRET, s1.token, 1).credits, 1);        // the re-minted token is real
  const s2 = spendCredit(SECRET, s1.token, 1);
  assert.equal(s2.remaining, 0);
  assert.equal(s2.token, null);
  assert.equal(spendCredit(SECRET, 'junk', 1).ok, false);
});

// ── exact boundaries: where off-by-one mutants live ──────────────────────────
test('cap/timeout boundaries: zero and negatives fall to the defaults, never through', () => {
  assert.equal(parseVerifyRequest({ ...GOOD, cap: 0 }).req.cap, 200);          // 0 is not a cap
  assert.equal(parseVerifyRequest({ ...GOOD, cap: -5 }).req.cap, 200);         // kills && -> ||
  assert.equal(parseVerifyRequest({ ...GOOD, timeout: 0 }).req.timeout, 120000);
  assert.equal(parseVerifyRequest({ ...GOOD, timeout: -5 }).req.timeout, 120000);
});
test('credit boundaries: 16-char secret OK, expiry 0 refused, non-integer expiry refused, 1000000 credits OK', () => {
  const s16 = 'x'.repeat(16);
  assert.equal(mintCreditToken(s16, 1, 10).ok, true);                          // exactly the minimum secret
  assert.equal(mintCreditToken(SECRET, 1, 0).ok, false);                       // expiresMs 0 is not a future
  assert.equal(mintCreditToken(SECRET, 3, 2.5).ok, false);                     // kills || -> && on the expiry guard
  assert.equal(mintCreditToken(SECRET, 1000000, 10).ok, true);                 // the top of the range is inside it
  assert.equal(mintCreditToken(SECRET, 1000001, 10).ok, false);
});
test('a forged zero-credit token with a VALID mac is still refused as spent', () => {
  const payload = 'v1.0.9999999';
  const mac = createHmac('sha256', SECRET).update(payload).digest('hex');
  const v = verifyCreditToken(SECRET, `${payload}.${mac}`, 1);
  assert.equal(v.ok, false);
  assert.match(v.error, /spent/);
});
test('the rerun steps are the exact shell lines, operators intact', () => {
  const req = parseVerifyRequest({ ...GOOD, files: ['index.js'], testCommand: 'npm test' }).req;
  const steps = shapeResult({ receipt: {}, verdict: { badge: true, summary: {} }, req }).rerun.steps;
  assert.ok(steps[0].includes(`subject && cd subject && git checkout ${SHA}`), 'clone step chains with &&');
  assert.ok(steps.at(-1).includes('witness && node witness/witness-bench.mjs prove'), 'gate step chains with &&');
});

// ── payments state, quote, challenge ─────────────────────────────────────────
const ACTIVE = { STRIPE_SECRET_KEY: 'sk_test_x_longer', PRICE_CENTS: '500', CREDIT_SECRET: SECRET };
test('paymentsActive needs all three of key, price and credit secret', () => {
  assert.equal(paymentsActive({}), false);
  assert.equal(paymentsActive({ ...ACTIVE, PRICE_CENTS: '0' }), false);
  assert.equal(paymentsActive({ ...ACTIVE, CREDIT_SECRET: 'short' }), false);
  assert.equal(paymentsActive(ACTIVE), true);
  // the exact edges: a 16-char credit secret is enough; an 8-char stripe key is not
  assert.equal(paymentsActive({ ...ACTIVE, CREDIT_SECRET: 'y'.repeat(16) }), true);
  assert.equal(paymentsActive({ ...ACTIVE, CREDIT_SECRET: 'y'.repeat(15) }), false);
  assert.equal(paymentsActive({ ...ACTIVE, STRIPE_SECRET_KEY: 'sk_12345' }), false);
  assert.equal(paymentsActive({ ...ACTIVE, STRIPE_SECRET_KEY: 'sk_123456' }), true);
});
test('the quote is honestly free when inactive and carries env terms when active', () => {
  const free = quote({});
  assert.equal(free.active, false);
  assert.equal(free.free, true);
  assert.match(free.note, /never hardcoded/);
  const paid = quote({ ...ACTIVE, PRICE_CURRENCY: 'GBP' });
  assert.equal(paid.active, true);
  assert.equal(paid.unitAmountCents, 500);
  assert.equal(paid.currency, 'gbp');
});
test('the 402 challenge offers the stripe rail only when the rail is real', () => {
  assert.deepEqual(paymentChallenge({}).accepts, []);
  const c = paymentChallenge(ACTIVE);
  assert.equal(c.status, 402);
  assert.equal(c.accepts[0].rail, 'stripe-checkout');
  assert.equal(c.accepts[0].start, '/pay');
});

// ── shapeResult: the receipt plus the means to distrust us ───────────────────
test('the response carries the verdict, the rerun steps, and the Konomi credit', () => {
  const req = parseVerifyRequest({ ...GOOD, files: ['index.js'], testCommand: 'npx mocha tests.js', install: true }).req;
  const out = shapeResult({ receipt: { hash: 'h' }, verdict: { badge: false, summary: { mutants: 17, killed: 15, survived: 2, score: 0.882 } }, req, spent: { remaining: 4 } });
  assert.equal(out.subject.sha, SHA);
  assert.equal(out.verdict.badge, false);
  assert.equal(out.verdict.killed, 15);
  assert.ok(out.rerun.steps.some((s) => s.includes(`git checkout ${SHA}`)));
  assert.ok(out.rerun.steps.some((s) => s.includes('witness.bench.json')));
  assert.ok(out.rerun.steps.some((s) => s.includes('--ignore-scripts')));
  assert.equal(out.credits.remaining, 4);
  assert.match(out.credit, /Thomas Frumkin/);
  // a repo with its own bench file gets told so instead of a synthetic config line
  const req2 = parseVerifyRequest(GOOD).req;
  const out2 = shapeResult({ receipt: {}, verdict: { badge: true, summary: {} }, req: req2 });
  assert.ok(out2.rerun.steps.some((s) => s.includes('its own witness.bench.json')));
  assert.equal(out2.credits, undefined);
});
