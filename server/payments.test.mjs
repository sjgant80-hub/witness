// server/payments.test.mjs — the Stripe seam, stubbed fetch. The live-key path is exercised against
// these stubs only; the first real-key run is verified by hand on activation day (no fake greens).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeForm, checkoutParams, sessionPaid, createCheckout, fetchSession } from './payments.mjs';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_abc', PRICE_CENTS: '500', PRICE_CURRENCY: 'usd' };

test('encodeForm writes Stripe\'s bracket syntax for nested params and arrays', () => {
  const s = encodeForm({ a: 1, b: { c: { d: 2 } }, e: [3, 4] });
  assert.ok(s.includes('a=1'));
  assert.ok(decodeURIComponent(s).includes('b[c][d]=2'));
  assert.ok(decodeURIComponent(s).includes('e[0]=3'));
  assert.ok(decodeURIComponent(s).includes('e[1]=4'));
  assert.equal(encodeForm({}), '');
});

test('checkoutParams refuses bad credit counts and a missing price; a good call carries quantity and cents', () => {
  assert.equal(checkoutParams(ENV, 0).ok, false);
  assert.equal(checkoutParams(ENV, 1.5).ok, false);
  assert.equal(checkoutParams(ENV, 10001).ok, false);
  assert.equal(checkoutParams(ENV, 10000).ok, true);                      // the top of the range is inside it
  assert.equal(checkoutParams({ ...ENV, PRICE_CENTS: undefined }, 1).ok, false);
  assert.equal(checkoutParams({ ...ENV, PRICE_CENTS: '0' }, 1).ok, false); // zero is not a price
  const p = checkoutParams(ENV, 25);
  assert.equal(p.ok, true);
  assert.equal(p.params['line_items[0]'].quantity, 25);
  assert.equal(p.params['line_items[0]'].price_data.unit_amount, 500);
  assert.equal(p.params.metadata.credits, 25);
  assert.equal(p.params.mode, 'payment');
  // the env defaults hold when the owner sets nothing beyond the key and the price — the currency
  // default must fire from an env that genuinely lacks PRICE_CURRENCY
  const d = checkoutParams({ STRIPE_SECRET_KEY: 'sk_test_abc', PRICE_CENTS: '500' }, 1);
  assert.equal(d.ok, true);
  assert.equal(d.params['line_items[0]'].price_data.currency, 'usd');
  assert.match(d.params.success_url, /sjgant80-hub\.github\.io\/witness/);
  assert.match(d.params.cancel_url, /sjgant80-hub\.github\.io\/witness/);
});

test('encodeForm skips null and undefined values entirely', () => {
  assert.equal(encodeForm({ a: null }), '');
  assert.equal(encodeForm({ a: undefined }), '');
  assert.equal(encodeForm({ a: null, b: 1 }), 'b=1');
});

test('sessionPaid demands payment_status=paid AND our credits metadata', () => {
  assert.equal(sessionPaid(null).paid, false);
  assert.equal(sessionPaid({ payment_status: 'unpaid', metadata: { credits: '5' } }).paid, false);
  assert.equal(sessionPaid({ payment_status: 'paid', metadata: {} }).paid, false);
  assert.match(sessionPaid({ payment_status: 'paid', metadata: {} }).why, /not one of ours/);
  assert.equal(sessionPaid({ payment_status: 'paid', metadata: { credits: '0' } }).paid, false);  // zero credits is nothing
  assert.match(sessionPaid({}).why, /absent/);                                 // a status-less session says so
  const ok = sessionPaid({ payment_status: 'paid', metadata: { credits: '5' } });
  assert.equal(ok.paid, true);
  assert.equal(ok.credits, 5);
});

test('createCheckout posts the encoded form with the bearer key and returns the session', async () => {
  let seen = null;
  const stub = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.example/x' }) }; };
  const r = await createCheckout(ENV, 2, stub);
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, 'cs_test_1');
  assert.equal(seen.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(seen.opts.headers.Authorization, 'Bearer sk_test_abc');
  assert.ok(decodeURIComponent(seen.opts.body).includes('line_items[0][quantity]=2'));
});
test('createCheckout surfaces a Stripe refusal instead of pretending', async () => {
  const stub = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'no such price' } }) });
  const r = await createCheckout(ENV, 2, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /no such price/);
  // a refusal with NO error object falls back to the status code, and never throws
  const bare = async () => ({ ok: false, status: 400, json: async () => ({}) });
  const r2 = await createCheckout(ENV, 2, bare);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /400/);
  const r3 = await fetchSession(ENV, 'cs_test_1', bare);
  assert.equal(r3.ok, false);
  assert.match(r3.error, /400/);
});
test('fetchSession refuses a malformed id before any network call, and fetches a real one', async () => {
  assert.equal((await fetchSession(ENV, 'junk id', async () => { throw new Error('must not be called'); })).ok, false);
  const r = await fetchSession(ENV, 'cs_test_1', async (url) => ({ ok: true, json: async () => ({ id: 'cs_test_1', from: url }) }));
  assert.equal(r.ok, true);
  assert.equal(r.session.id, 'cs_test_1');
});
