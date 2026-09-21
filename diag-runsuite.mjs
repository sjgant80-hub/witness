// Replicate witness.mjs runSuiteOnce() EXACTLY, to see what base.ok is judged on
// when gating runner.mjs. base.ok = (r.status === 0). If this is non-zero we see WHY.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const RUNNER = join(process.cwd(), 'runner.mjs');
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;                       // childEnv()
const timeout = 600000;
const testCmd = ['node', '--test', 'witness.test.mjs'];
const detached = process.platform !== 'win32';

const r = spawnSync(process.execPath, [RUNNER, String(timeout), ...testCmd], {
  cwd: process.cwd(), env, encoding: 'utf8',
  maxBuffer: 1 << 26, timeout: timeout + 15000, detached,
});

const out = (r.stdout || '') + (r.stderr || '');
console.log('=== base.ok would be:', r.status === 0, '===');
console.log('STATUS =', r.status);
console.log('SIGNAL =', r.signal);
console.log('ERROR  =', r.error && r.error.message);
console.log('OUT_LEN=', out.length);
console.log('--- summary lines ---');
console.log(out.split('\n').filter((l) => /^(not ok|# fail|# pass|# tests|# cancelled|# skipped)/.test(l.trim()) || /^(not ok|# )/.test(l)).join('\n'));
console.log('--- not-ok blocks (name + failureType/code) ---');
const lines = out.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (/^not ok /.test(lines[i].trim())) {
    console.log(lines.slice(i, i + 10).join('\n'));
    console.log('...');
  }
}
console.log('--- TAIL 2000 ---');
console.log(out.slice(-2000));
