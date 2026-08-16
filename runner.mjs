#!/usr/bin/env node
// runner.mjs — run one test command under a bound, and take its whole tree down with it.
//
// ⚑ WHY THIS PROCESS EXISTS AT ALL. witness used to hand the bound to spawnSync's own `timeout`,
// which signals the process it started — and that process is almost never the one doing the work.
// `npm test` spawns `sh`, which spawns `node`. Node kills npm; the grandchildren carry on.
//
// The reason it cannot be fixed in the parent is timing. By the moment spawnSync RETURNS, the child
// it killed is already dead, and with it every link witness could have followed to find the rest:
// on Windows the tree is walked parent-to-child, so an orphan whose parent has gone is unreachable;
// on POSIX the group survives, which is why a group kill helps there and nowhere else. The killing
// has to happen while the parent is still alive, and nothing that blocks until the child exits can
// do that. So a supervisor sits in between, holding the handle, watching its own clock.
//
//   node runner.mjs <timeoutMs> <cmd> [args...]
//
// Exits with the child's own code, or 124 (the conventional timeout code) when the bound was hit.
// Either way the tree is gone before this process returns.
import { spawn, spawnSync } from 'node:child_process';

const [, , boundArg, ...cmd] = process.argv;
const bound = Number(boundArg);
if (!Number.isFinite(bound) || bound <= 0 || cmd.length === 0) {
  console.error('runner: usage — node runner.mjs <timeoutMs> <cmd> [args...]');
  process.exit(2);
}

const onWindows = process.platform === 'win32';
const child = spawn(cmd[0], cmd.slice(1), {
  stdio: 'inherit',
  shell: onWindows,          // npm is npm.cmd here; the parent relied on the same thing
  detached: !onWindows,      // POSIX: its own process group, so one signal reaches the whole tree
});

// Kill the tree while this process is still its ancestor and the links still resolve.
function killTree() {
  try {
    if (onWindows) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone is the good case */ }
}

let timedOut = false;
const timer = setTimeout(() => { timedOut = true; killTree(); }, bound);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  // Even on a clean exit: a suite can leave a daemon behind on its way out, and the next mutant
  // would then be racing it. Sweep regardless of how the run ended.
  killTree();
  if (timedOut) process.exit(124);
  process.exit(signal ? 128 + 15 : (code ?? 1));
});

child.on('error', (e) => {
  clearTimeout(timer);
  console.error(`runner: could not start ${cmd[0]}: ${e.message}`);
  process.exit(127);
});
