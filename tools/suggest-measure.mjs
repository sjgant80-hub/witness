#!/usr/bin/env node
// tools/suggest-measure.mjs — the measurement SUGGEST.md fixed before the code: on the estate commits where a person
// killed survivors with tests alone, how many of those survivors does `witness suggest` kill automatically?
//
// For each case (repo, commit K, kernel, its CI test command), on two plain copies of the repo (git archive, so no
// working tree is touched):
//   S0  = survivors at K^ (the tests before the person's fix), no baseline: the full witness gate
//   S1  = which of S0 still survive at K (the person's tests): each S0 survivor's mutant re-run there
//   S2  = which of S0 still survive at K^ with the suggested test added: re-run with it
//   killable = S0 − S1 · suggested = S0 − S2 · hits = killable ∩ suggested · contradicts = S1 ∩ suggested
//
//   node tools/suggest-measure.mjs <work dir holding <repo>-pre and <repo>-post> [--only <repo>]   (one repo: its own file)
//   node tools/suggest-measure.mjs <work dir> --pool                                         (pool the per-repo files)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mutants, runMutations } from '../witness.mjs';
import { candidatesFor } from '../suggest-core.mjs';
import { suggest } from '../suggest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = [
  { repo: 'fall-kit', commit: 'a98efc4', kernel: 'core/node.mjs', test: ['node', 'core/node.test.mjs'] },
  { repo: 'fallkard-forge', commit: 'd15ee24', kernel: 'png.mjs', test: ['node', '--test', 'test.mjs', 'forge-estate.test.mjs', 'art-band.test.mjs'] },
  { repo: 'fallkard-forge', commit: 'd15ee24', kernel: 'forge.mjs', test: ['node', '--test', 'test.mjs', 'card.test.mjs', 'forge-estate.test.mjs', 'forge.green.test.mjs', 'reader.test.mjs'] },
  { repo: 'fallkard-forge', commit: 'd15ee24', kernel: 'lineage.mjs', test: ['node', '--test', 'test.mjs', 'forge-estate.test.mjs'] },
  { repo: 'the-dreamer', commit: '178eca0', kernel: 'dreamer.mjs', test: ['node', 'test.mjs'] },
];
const NOT_MEASURED = [
  { repo: 'si-didy-cascade', commit: '10e5185', why: 'the commit before it had no tests at all (test.mjs is added by 10e5185), so the gate cannot run there and there is no S0' },
];
const T = 180000;
const key = (s) => s.line + ' ' + s.mutation + ' :: ' + s.snippet;
const run = (cmd, cwd) => spawnSync(cmd[0] === 'node' ? process.execPath : cmd[0], cmd.slice(1), { cwd, timeout: T, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }).status === 0;

/** does survivor s still survive in dir: is there a mutant on its line, with its operator, that the tests let through? */
function alive(dir, kernel, test, s, extra) {
  const path = join(dir, kernel), original = readFileSync(path, 'utf8');
  try {
    for (const m of candidatesFor(mutants(original), s)) {
      writeFileSync(path, m.source);
      if (run(test, dir) && (!extra || run(extra, dir))) return true;
    }
    return false;
  } finally { writeFileSync(path, original); }
}

async function main() {
  const work = process.argv[2], oi = process.argv.indexOf('--only'), only = oi >= 0 ? process.argv[oi + 1] : null;
  if (!work) { console.error('usage: node tools/suggest-measure.mjs <work dir> [--only <repo>]'); process.exit(2); }
  const empty = join(work, 'empty-baseline.json');
  if (!existsSync(empty)) writeFileSync(empty, '[]\n');
  const witness = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const out = join(work, 'suggest-measure' + (only ? '-' + only : '') + '.json');
  const done = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { cases: [] };
  if (process.argv.includes('--pool')) {   // pool every per-repo file into suggest-measure.json
    const { readdirSync } = await import('node:fs');
    done.cases = readdirSync(work).filter((f) => /^suggest-measure-.+\.json$/.test(f)).flatMap((f) => JSON.parse(readFileSync(join(work, f), 'utf8')).cases);
    CASES.length = 0;
  }
  for (const c of CASES) {
    if (only && c.repo !== only) continue;
    const pre = join(work, c.repo + '-pre'), post = join(work, c.repo + '-post');
    console.error('== ' + c.repo + ' ' + c.kernel + ' · S0 (the gate at ' + c.commit + '^, no baseline) …');
    const r0 = runMutations(join(pre, c.kernel), { testCmd: c.test, cwd: pre, cap: 2000, timeout: T, baseline: empty });
    if (r0.baselineFailed || r0.noMutants) { done.cases.push({ ...c, error: r0.reason }); continue; }
    const S0 = r0.survived;
    console.error('   ' + S0.length + ' survivor(s) of ' + r0.total + ' · S1 at ' + c.commit + ' …');
    const S1 = S0.filter((s) => alive(post, c.kernel, c.test, s));
    console.error('   ' + S1.length + ' still survive the person\'s tests · suggest at ' + c.commit + '^ …');
    const sug = await suggest(c.kernel, { survivors: S0, testCmd: c.test, cwd: pre });
    const S2 = sug.file ? S0.filter((s) => alive(pre, c.kernel, c.test, s, ['node', sug.file])) : S0;
    const k1 = new Set(S1.map(key)), k2 = new Set(S2.map(key));
    const killable = S0.filter((s) => !k1.has(key(s))), suggested = S0.filter((s) => !k2.has(key(s)));
    const row = { ...c, witness, total: r0.total, S0: S0.map(key), S1: S1.map(key), S2: S2.map(key), recorded: sug.recorded,
      killable: killable.length, suggested: suggested.length, hits: killable.filter((s) => !k2.has(key(s))).map(key), contradicts: S1.filter((s) => !k2.has(key(s))).map(key),
      why: sug.report.filter((r) => r.status !== 'killed').map((r) => key(r) + ' — ' + r.why),
      file: sug.file ? readFileSync(sug.file, 'utf8') : null,
      passesOnReal: sug.file ? run(['node', sug.file], pre) : null };   // C1's second half: no suggested test fails on the real code
    console.error('   killable ' + row.killable + ' · suggest killed ' + row.suggested + ' · of the killable ' + row.hits.length + ' · contradicting a person\'s call ' + row.contradicts.length);
    done.cases = done.cases.filter((x) => !(x.repo === c.repo && x.kernel === c.kernel)).concat([row]);
    writeFileSync(out, JSON.stringify(done, null, 1) + '\n');
  }
  const ok = done.cases.filter((x) => !x.error), killable = ok.reduce((n, x) => n + x.killable, 0), hits = ok.reduce((n, x) => n + x.hits.length, 0);
  done.notMeasured = NOT_MEASURED;
  const falseTests = ok.filter((x) => x.passesOnReal === false).length;
  done.pooled = { killable, hits, share: killable ? hits / killable : null, falseTests, c1: killable > 0 && hits * 2 >= killable && falseTests === 0 };
  writeFileSync(out, JSON.stringify(done, null, 1) + '\n');
  console.log(JSON.stringify(done.pooled));
}
main();
