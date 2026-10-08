// server/payments.mjs · the Stripe rail for the verify tool — KEY-READY, honestly
//
// Zero dependencies: Stripe's REST API over fetch, form-encoded. The flow is deliberately
// webhook-free so it can run anywhere (an agent-friendly poll):
//   1. POST /pay {credits}        -> we create a Stripe Checkout Session, return its URL + id
//   2. buyer (or their human) pays at the URL
//   3. POST /redeem {sessionId}   -> we fetch the session with the secret key; if payment_status
//                                    is "paid" and it has not been redeemed before, we mint a
//                                    bearer credit token for exactly the credits bought
//
// The param-building and the paid-check are PURE (gate-covered); fetch is injected so tests use a
// stub. ⚑ ACTIVATION-DAY RULE: the live-key path has been exercised only against the stub — the
// first run with real keys must be verified by hand before the quote goes active. No fake greens.

export function encodeForm(obj) {
  const parts = [];
  const walk = (key, val) => {
    if (val === null || val === undefined) return;
    if (typeof val === 'object' && !Array.isArray(val)) { for (const k of Object.keys(val)) walk(`${key}[${k}]`, val[k]); return; }
    if (Array.isArray(val)) { val.forEach((v, i) => walk(`${key}[${i}]`, v)); return; }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
  };
  for (const k of Object.keys(obj || {})) walk(k, obj[k]);
  return parts.join('&');
}

// the Checkout Session params for N verification credits. Price comes ONLY from env.
export function checkoutParams(env, credits) {
  if (!Number.isInteger(credits) || credits <= 0 || credits > 10000) return { ok: false, error: 'credits must be an integer in 1..10000' };
  const cents = Number(env.PRICE_CENTS);
  if (!Number.isInteger(cents) || cents <= 0) return { ok: false, error: 'PRICE_CENTS is not set — payments are not active' };
  return {
    ok: true,
    params: {
      mode: 'payment',
      'line_items[0]': {
        quantity: credits,
        price_data: {
          currency: (env.PRICE_CURRENCY || 'usd').toLowerCase(),
          unit_amount: cents,
          product_data: { name: 'witness verification run (re-runnable Proof-of-Play receipt)' },
        },
      },
      metadata: { credits, product: 'witness-verify' },
      success_url: env.PAY_SUCCESS_URL || 'https://sjgant80-hub.github.io/witness/?paid=1',
      cancel_url: env.PAY_CANCEL_URL || 'https://sjgant80-hub.github.io/witness/',
    },
  };
}

// does a fetched Checkout Session represent a settled purchase, and for how many credits?
export function sessionPaid(sessionJson) {
  if (!sessionJson || typeof sessionJson !== 'object') return { paid: false, why: 'no session' };
  if (sessionJson.payment_status !== 'paid') return { paid: false, why: `payment_status is ${sessionJson.payment_status || 'absent'}` };
  const credits = Number(sessionJson.metadata && sessionJson.metadata.credits);
  if (!Number.isInteger(credits) || credits <= 0) return { paid: false, why: 'session carries no credits metadata — not one of ours' };
  return { paid: true, credits };
}

// ── the two live calls (fetch injected; stubbed in tests) ────────────────────
export async function createCheckout(env, credits, fetchImpl = fetch) {
  const p = checkoutParams(env, credits);
  if (!p.ok) return p;
  const r = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm(p.params),
  });
  const j = await r.json();
  if (!r.ok) return { ok: false, error: `stripe refused: ${(j.error && j.error.message) || r.status}` };
  return { ok: true, sessionId: j.id, url: j.url };
}

export async function fetchSession(env, sessionId, fetchImpl = fetch) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) return { ok: false, error: 'malformed session id' };
  const r = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const j = await r.json();
  if (!r.ok) return { ok: false, error: `stripe refused: ${(j.error && j.error.message) || r.status}` };
  return { ok: true, session: j };
}

export default { encodeForm, checkoutParams, sessionPaid, createCheckout, fetchSession };
