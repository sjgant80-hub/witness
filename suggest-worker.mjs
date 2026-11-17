// witness suggest · the worker: call the real code and one mutant on the same inputs, in this child process, and
// print one line per input as it goes (written synchronously, so a mutant that loops forever still leaves the line
// that says which input it was on). The parent bounds the whole run with a timeout. Stops after `want` differences.
//   node suggest-worker.mjs <payload.json>    payload: { orig, mut, calls: [[name, argsB64]], want, ms }
import { readFileSync, writeSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { shape, same, pick, outcome } from './suggest-core.mjs';

const say = (o) => writeSync(1, JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v + 'n' : v)) + '\n');
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const O = await import(p.orig);
const want = p.want || 3, ms = p.ms || 3000;
// only the real code, on one input: what it gives, for an input the mutant never finished on
if (p.only !== undefined) {
  const [name, b64] = p.calls[p.only], f = pick(O, name);
  if (f) {
    const a = await outcome(f, deserialize(Buffer.from(b64, 'base64')), ms);
    let expectB64 = null;
    try { expectB64 = serialize(a).toString('base64'); } catch { /* not storable */ }
    say({ i: p.only, name, expectB64, expect: shape(a) });
  }
  say({ done: true });
  process.exit(0);
}
const X = await import(p.mut);
let found = 0;
for (let i = 0; i < p.calls.length && found < want; i++) {
  const [name, b64] = p.calls[i];
  const f = pick(O, name), g = pick(X, name);
  if (!f || !g) continue;
  const args = () => deserialize(Buffer.from(b64, 'base64'));
  say({ i, start: true });
  const a = await outcome(f, args(), ms);
  const b = await outcome(g, args(), ms);
  if (same(a, b)) continue;
  found++;
  let expectB64 = null;
  try { expectB64 = serialize(a).toString('base64'); } catch { /* not storable: skipped below */ }
  say({ i, diff: true, name, expectB64, expect: shape(a), got: shape(b) });
}
say({ done: true });
process.exit(0);
