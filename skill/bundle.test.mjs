// bundle.test.mjs — proves scripts/witness-mutation-gate.mjs is witness v0.6, run the way Agensi runs it:
// alone, from a folder that holds nothing else of the package.
//   1. v0.6's own test suite, taken from the git tag, passes against the bundle in a folder with no runner.mjs.
//      The one v0.6 test that starts runner.mjs directly is pointed at the bundle's runner mode instead.
//   2. `receipt` end to end on v0.6's fixtures: a theatre suite gives SURVIVORS, a good one CLEAN, the source
//      file comes back byte-identical, and the receipt's own rerun command reproduces the verdict.
//   3. On POSIX, the bundle still runs when reached through a symlink (v0.6's entry guard did not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const BUNDLE = resolve('scripts/witness-mutation-gate.mjs');
const env = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fromTag = (path) => execFileSync('git', ['show', `v0.6:${path}`], { maxBuffer: 1 << 26 });

function withDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function placeFixtures(dir) {
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  for (const f of ['boundary.mjs', 'boundary.theatre.test.mjs', 'boundary.good.test.mjs']) {
    writeFileSync(join(dir, 'fixtures', f), fromTag(`fixtures/${f}`));
  }
  copyFileSync(BUNDLE, join(dir, 'witness-mutation-gate.mjs'));
}

const run = (dir, args) => spawnSync(process.execPath, ['witness-mutation-gate.mjs', ...args], { cwd: dir, encoding: 'utf8', env: env(), maxBuffer: 1 << 26 });

test("v0.6's own test suite passes against the bundle, with no runner.mjs anywhere", { timeout: 3600000 }, () => {
  withDir('witness-bundle-', (dir) => {
    // --full-tree: run from skill/, ls-tree would otherwise list only paths under skill/ (none at v0.6)
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', '--full-tree', 'v0.6'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.ok(files.includes('witness.test.mjs') && files.includes('fixtures/boundary.mjs'), 'the v0.6 tree was read');
    for (const f of files) {
      if (f === 'witness.mjs' || f === 'runner.mjs') continue;      // the bundle replaces both
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), fromTag(f));
    }
    copyFileSync(BUNDLE, join(dir, 'witness.mjs'));
    assert.equal(existsSync(join(dir, 'runner.mjs')), false);
    const original = readFileSync(join(dir, 'witness.test.mjs'), 'utf8');
    const adapted = original
      .replace("new URL('./runner.mjs', import.meta.url)", "new URL('./witness.mjs', import.meta.url)")
      .split("[runner, '20000', ").join("[runner, '--witness-runner', '20000', ");
    assert.equal(adapted.split("'--witness-runner'").length - 1, 3, 'exactly the three runner calls were adapted');
    writeFileSync(join(dir, 'witness.test.mjs'), adapted);
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'witness.test.mjs'],
      { cwd: dir, encoding: 'utf8', env: env(), maxBuffer: 1 << 28 });
    const summary = (r.stdout || '').split('\n').filter((l) => /^not ok|^# (tests|pass|fail)/.test(l)).join('\n');
    assert.equal(r.status, 0, summary + '\n' + (r.stderr || '').slice(-1500));
    assert.match(r.stdout, /^# fail 0$/m);
  });
});

test('receipt: a theatre suite → SURVIVORS (exit 1), a good suite → CLEAN (exit 0); the source is restored', { timeout: 600000 }, () => {
  withDir('witness-receipt-', (dir) => {
    placeFixtures(dir);
    const src = join(dir, 'fixtures', 'boundary.mjs');
    const before = readFileSync(src);

    const bad = run(dir, ['receipt', 'fixtures/boundary.mjs', '--test', process.execPath, '--test', 'fixtures/boundary.theatre.test.mjs']);
    assert.equal(bad.status, 1, bad.stderr);
    const rb = JSON.parse(bad.stdout);
    assert.equal(rb.kind, 'witness-receipt');
    assert.equal(rb.verdict, 'SURVIVORS');
    assert.deepEqual(rb.survived.map((s) => [s.line, s.mutation]), [[3, '> → >=']]);
    assert.equal(rb.engine.sha256, sha(fromTag('witness.mjs')));
    assert.equal(rb.fileSha256, sha(before));

    const good = run(dir, ['receipt', 'fixtures/boundary.mjs', '--test', process.execPath, '--test', 'fixtures/boundary.good.test.mjs']);
    assert.equal(good.status, 0, good.stderr);
    const rg = JSON.parse(good.stdout);
    assert.equal(rg.verdict, 'CLEAN');
    assert.equal(rg.killed, rg.total);
    assert.ok(rg.total > 0);

    assert.deepEqual(readFileSync(src), before, 'the gated file is byte-identical afterwards');
    assert.equal(existsSync(src + '.witnessbak'), false);   // v0.6's sidecar backup is gone

    // the receipt's own rerun command reproduces the verdict (v0.6's `mutate` prints the bare result).
    // Arguments with spaces (a Windows node path) are JSON-quoted in it: parse them back the same way.
    const tokens = rg.rerun.match(/"(?:[^"\\]|\\.)*"|\S+/g).map((t) => (t.startsWith('"') ? JSON.parse(t) : t));
    assert.deepEqual(tokens.slice(0, 4), ['node', 'witness-mutation-gate.mjs', 'mutate', 'fixtures/boundary.mjs']);
    assert.deepEqual(tokens.slice(tokens.indexOf('--test') + 1), [process.execPath, '--test', 'fixtures/boundary.good.test.mjs']);
    const again = run(dir, tokens.slice(2));
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).clean, true);
  });
});

test('receipt: a red suite is GATE_DID_NOT_RUN, never a pass; bad arguments are exit 2', { timeout: 600000 }, () => {
  withDir('witness-red-', (dir) => {
    placeFixtures(dir);
    writeFileSync(join(dir, 'red.test.mjs'), "import { test } from 'node:test';\ntest('red', () => { throw new Error('red'); });\n");
    const red = run(dir, ['receipt', 'fixtures/boundary.mjs', '--test', process.execPath, '--test', 'red.test.mjs']);
    assert.equal(red.status, 1);
    const r = JSON.parse(red.stdout);
    assert.equal(r.verdict, 'GATE_DID_NOT_RUN');
    assert.match(r.reason, /does not pass/);
    assert.equal(run(dir, ['receipt']).status, 2);
    assert.equal(run(dir, ['receipt', 'no-such-file.mjs', '--test', 'x']).status, 2);
    assert.equal(run(dir, ['receipt', 'fixtures/boundary.mjs', '--cap', '0', '--test', 'x']).status, 2);
  });
});

test('fuzz through the bundle: a function that throws on hostile input fails the gate', { timeout: 120000 }, () => {
  withDir('witness-fuzz-', (dir) => {
    copyFileSync(BUNDLE, join(dir, 'witness-mutation-gate.mjs'));
    writeFileSync(join(dir, 'm.mjs'), 'export const strict = (x) => x.trim();\nexport const tolerant = (x) => (typeof x === "string" ? x.trim() : "");\n');
    const bad = run(dir, ['fuzz', './m.mjs', 'strict']);
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).neverThrows, false);
    const good = run(dir, ['fuzz', './m.mjs', 'tolerant']);
    assert.equal(good.status, 0);
    assert.equal(JSON.parse(good.stdout).neverThrows, true);
  });
});

test('the bundle still runs when reached through a symlink (POSIX)', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  withDir('witness-link-', (dir) => {
    mkdirSync(join(dir, 'real'));
    copyFileSync(BUNDLE, join(dir, 'real', 'witness-mutation-gate.mjs'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const r = spawnSync(process.execPath, [join(dir, 'link', 'witness-mutation-gate.mjs')], { encoding: 'utf8', env: env() });
    assert.equal(r.status, 2);                                    // usage, printed: main() ran
    assert.match(r.stderr, /witness — deterministic build gate/);
  });
});
