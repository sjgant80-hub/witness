// server/http.mjs · the surface: plain REST for any agent, MCP (JSON-RPC over POST) for MCP agents.
// Zero dependencies. Start:  node server/http.mjs   (PORT, default 8791)
//
// KEY-READY MODES
//   free (default, no keys):  /verify runs free within the allowlist and says so.
//   paid (STRIPE_SECRET_KEY + PRICE_CENTS + CREDIT_SECRET set):  /verify wants X-Credit-Token;
//        /pay sells credits via Stripe Checkout; /redeem turns a paid session into a bearer token.
//   open subjects (RUNNER_MODE=container):  any public repo — deploy ONLY in a disposable container.
import { createServer } from 'node:http';
import { parseVerifyRequest, allowDecision, spendCredit, mintCreditToken, paymentsActive, quote, paymentChallenge, shapeResult, PROTOCOL } from './verify-core.mjs';
import { createCheckout, fetchSession, sessionPaid } from './payments.mjs';
import { runVerifyJob, wasRedeemed, markRedeemed } from './jobs.mjs';

const env = process.env;
const PORT = Number(env.PORT) || 8794;          // 8791/8792 belong to other estate organs
const HOST = env.HOST || '127.0.0.1';           // deployment sets HOST=0.0.0.0 deliberately
const LINKS = {
  catalog: 'https://sjgant80-hub.github.io/kar-hub/catalog.json',
  guide: 'https://sjgant80-hub.github.io/kar-hub/agents.md',
  product: 'https://sjgant80-hub.github.io/witness/',
};
let BUSY = false;   // one gate run at a time — never two machine runs at once

const send = (res, code, obj, extra = {}) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Credit-Token', ...extra });
  res.end(body);
};
const readBody = (req) => new Promise((resolve) => {
  let s = ''; req.on('data', (d) => { s += d; if (s.length > 1 << 20) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve(null); } });
});

// ── the one worker both surfaces share ───────────────────────────────────────
async function doVerify(body, creditToken) {
  const parsed = parseVerifyRequest(body);
  if (!parsed.ok) return { code: 400, out: { error: parsed.error } };
  const allow = allowDecision(parsed.req, env);
  if (!allow.allowed) return { code: 403, out: { error: 'refused', why: allow.why, links: LINKS } };

  let spent = null;
  if (paymentsActive(env)) {
    const s = spendCredit(env.CREDIT_SECRET, creditToken, Date.now());
    if (!s.ok) return { code: 402, out: paymentChallenge(env) };
    spent = { remaining: s.remaining, token: s.token };
  }
  if (BUSY) return { code: 429, out: { error: 'busy — one verification runs at a time; retry shortly', retryAfterSeconds: 60 } };
  BUSY = true;
  try {
    const job = runVerifyJob(parsed.req);
    if (!job.ok) return { code: 422, out: { error: job.error, note: 'No receipt is minted for a run the gate could not complete — an empty run is not a pass.' } };
    return { code: 200, out: shapeResult({ receipt: job.receipt, verdict: { badge: job.receipt.verdict.badge, summary: receiptCounts(job.receipt) }, req: parsed.req, spent }) };
  } finally { BUSY = false; }
}
const receiptCounts = (r) => {
  const killed = r.verdict?.core ?? null, survived = r.verdict?.nonCore ?? null;
  const mutants = killed !== null && survived !== null ? killed + survived : null;
  return { mutants, killed, survived, score: mutants ? Math.round((killed / mutants) * 1000) / 1000 : null };
};

// ── MCP: JSON-RPC 2.0 over POST / ────────────────────────────────────────────
const TOOLS = [
  { name: 'quote', description: 'Payment status and terms for the verify tool. Free to call.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'verify_repo',
    description: 'Run the witness mutation gate against a repository pinned to an exact commit, using its own test suite. Returns a re-runnable Proof-of-Play receipt (content-addressed, no trusted signer) plus the exact steps to reproduce the verdict without this service.',
    inputSchema: {
      type: 'object',
      properties: {
        repoUrl: { type: 'string', description: 'https git URL (github.com / gitlab.com / codeberg.org)' },
        sha: { type: 'string', description: 'full 40-hex commit — branches are refused; verdicts must reproduce' },
        files: { type: 'array', items: { type: 'string' }, description: 'source files to gate (omit if the repo has witness.bench.json)' },
        testCommand: { type: 'string', description: 'the repo’s test command (with files)' },
        install: { type: 'boolean', description: 'run npm install --ignore-scripts first' },
        cap: { type: 'number' }, timeout: { type: 'number' },
        creditToken: { type: 'string', description: 'X-Credit-Token value, when payments are active' },
      },
      required: ['repoUrl', 'sha'],
    },
  },
];

async function mcp(msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const rpcError = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'witness-verify', version: '1', description: 'Mutation-gate verification with re-runnable receipts. ' + LINKS.guide } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      if (name === 'quote') return reply({ content: [{ type: 'text', text: JSON.stringify({ ...quote(env), links: LINKS }, null, 2) }] });
      if (name === 'verify_repo') {
        const r = await doVerify(args, args.creditToken);
        return reply({ content: [{ type: 'text', text: JSON.stringify(r.out, null, 2) }], isError: r.code >= 400 });
      }
      return rpcError(-32602, `unknown tool ${name}`);
    }
    default:
      return msg.method && msg.method.startsWith('notifications/') ? null : rpcError(-32601, `unknown method ${msg.method}`);
  }
}

// ── routes ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/healthz')
    return send(res, 200, { ok: true, protocol: PROTOCOL, payments: paymentsActive(env) ? 'active' : 'inactive (free mode)', busy: BUSY, links: LINKS });
  if (req.method === 'GET' && url.pathname === '/quote') return send(res, 200, { ...quote(env), links: LINKS });

  if (req.method === 'POST' && url.pathname === '/pay') {
    if (!paymentsActive(env)) return send(res, 409, { error: 'payments are not active — /verify is free right now', quote: quote(env) });
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'invalid JSON' });
    const r = await createCheckout(env, Number(body.credits) || 1);
    return r.ok ? send(res, 200, { sessionId: r.sessionId, url: r.url, next: 'pay at url, then POST /redeem {sessionId}' }) : send(res, 502, r);
  }

  if (req.method === 'POST' && url.pathname === '/redeem') {
    if (!paymentsActive(env)) return send(res, 409, { error: 'payments are not active' });
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'invalid JSON' });
    const s = await fetchSession(env, body.sessionId); if (!s.ok) return send(res, 502, s);
    const paid = sessionPaid(s.session);
    if (!paid.paid) return send(res, 402, { error: 'not paid', why: paid.why });
    if (wasRedeemed(body.sessionId)) return send(res, 409, { error: 'this session was already redeemed — a purchase buys credits exactly once' });
    const t = mintCreditToken(env.CREDIT_SECRET, paid.credits, Date.now() + 90 * 24 * 3600 * 1000);
    if (!t.ok) return send(res, 500, t);
    markRedeemed(body.sessionId, paid.credits);
    return send(res, 200, { token: t.token, credits: paid.credits, note: 'bearer token — keep it like cash; send as X-Credit-Token on /verify' });
  }

  if (req.method === 'POST' && url.pathname === '/verify') {
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'invalid JSON' });
    const r = await doVerify(body, req.headers['x-credit-token']);
    return send(res, r.code, r.out);
  }

  if (req.method === 'POST' && url.pathname === '/') {       // MCP
    const body = await readBody(req); if (!body) return send(res, 400, { error: 'invalid JSON-RPC' });
    const msgs = Array.isArray(body) ? body : [body];
    const replies = (await Promise.all(msgs.map(mcp))).filter(Boolean);
    if (replies.length === 0) { res.writeHead(202); return res.end(); }
    return send(res, 200, Array.isArray(body) ? replies : replies[0]);
  }

  return send(res, 404, { error: 'not found', surfaces: ['/healthz', '/quote', 'POST /verify', 'POST /pay', 'POST /redeem', 'POST / (MCP JSON-RPC)'], links: LINKS });
});

server.listen(PORT, HOST, () => {
  console.error(`witness-verify listening on ${HOST}:${PORT} — payments ${paymentsActive(env) ? 'ACTIVE' : 'inactive (free mode)'} · subjects ${env.RUNNER_MODE === 'container' ? 'OPEN (container mode)' : 'allowlist'}`);
});
