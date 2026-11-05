// landing/check.mjs — did this run reproduce the committed landing? Run by the landing workflow after the gate.
//
// The page says the vercel/ms receipt reproduces on a clean runner. Until v0.7 that was read by eye from the log; now
// the monthly run says it, and fails when it is not true. Two different reasons are kept apart, because only one of
// them is news about the code under test:
//   - INSTRUMENT CHANGED: the receipt was minted under a different witness (its fingerprint covers witness.mjs, the
//     operator set and the exemption bar). Not a fault in ms. The landing is re-minted from this run's artifact,
//     and the old receipt is kept under landing/history/.
//   - NOT REPRODUCED: same instrument, different anchor. That is the failure the receipt exists to expose.
//
//   node landing/check.mjs <fresh witness-receipt.json> <committed landing/ms-receipt.json>
import { readFileSync } from 'node:fs';

const [freshPath, keptPath] = process.argv.slice(2);
if (!freshPath || !keptPath) { console.error('usage: node landing/check.mjs <fresh receipt> <committed receipt>'); process.exit(2); }
const fresh = JSON.parse(readFileSync(freshPath, 'utf8'));
const kept = JSON.parse(readFileSync(keptPath, 'utf8'));
const fpFresh = fresh.benchmark && fresh.benchmark.fingerprint;
const fpKept = kept.benchmark && kept.benchmark.fingerprint;
if (fpFresh !== fpKept) {
  console.log(`INSTRUMENT CHANGED — the committed receipt was minted under gate ${fpKept}, this run's gate is ${fpFresh}.`);
  console.log(`Not a fault in the library. This run's verdict: ${fresh.verdict.core} killed, ${fresh.verdict.nonCore} survived, anchor ${fresh.hash}.`);
  console.log('Re-mint the landing from this run\'s artifact and keep the old receipt under landing/history/.');
  process.exit(1);
}
if (fresh.hash !== kept.hash) {
  console.log(`NOT REPRODUCED — same gate, different anchor: committed ${kept.hash}, this run ${fresh.hash}.`);
  console.log(`committed ${kept.verdict.core} killed / ${kept.verdict.nonCore} survived · this run ${fresh.verdict.core} / ${fresh.verdict.nonCore}`);
  process.exit(1);
}
console.log(`REPRODUCED — anchor ${fresh.hash} (${fresh.verdict.core} killed, ${fresh.verdict.nonCore} survived) under gate ${fpFresh}.`);
