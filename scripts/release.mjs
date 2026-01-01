// Ends a hold of scripts/e2e.mjs.
//
//   node scripts/release.mjs [--report-dir <dir>]
//
// Signals only the pid in <dir>/harness.pid, and only when it is a node process running
// scripts/e2e.mjs; prints RELEASED once that process is gone and the port in
// <dir>/ports.env refuses connections. Without harness.pid it prints RELEASED when the
// port is free, so a second release succeeds too.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const WAIT_MS = 120_000;
const POLL_MS = 100;

const { values: options } = parseArgs({
  options: { 'report-dir': { type: 'string', default: 'target/e2e-runs' } },
});
const runDir = resolve(options['report-dir']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function heldPort() {
  const match = /^TALLY_PORT=(\d+)$/m.exec(readOrNull(join(runDir, 'ports.env')) ?? '');
  return match ? Number(match[1]) : null;
}

function heldPid() {
  const text = readOrNull(join(runDir, 'harness.pid'));
  if (text === null) return null;
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) fail(`harness.pid in ${runDir} does not hold a pid`);
  return pid;
}

// A zombie counts as gone: it holds no port and only waits for its parent to reap it.
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  const stat = readOrNull(`/proc/${pid}/stat`);
  return stat === null || stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
}

function commandLine(pid) {
  const raw = readOrNull(`/proc/${pid}/cmdline`);
  if (raw !== null) return raw.split('\0').filter(Boolean);
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim().split(/\s+/);
  } catch {
    return [];
  }
}

function isRunner(pid) {
  const argv = commandLine(pid);
  return argv.length > 0 && /^node/.test(basename(argv[0])) && argv.some((arg) => arg.includes('scripts/e2e.mjs'));
}

function portOpen(port) {
  if (port === null) return Promise.resolve(false);
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

async function cleared(pid, port) {
  return !(pid !== null && alive(pid)) && !(await portOpen(port));
}

const port = heldPort();
const pid = heldPid();

if (pid !== null && alive(pid)) {
  if (!isRunner(pid)) fail(`refusing to signal pid ${pid}: it is not a node process running scripts/e2e.mjs`);
  process.kill(pid, 'SIGTERM');
}

const deadline = Date.now() + WAIT_MS;
while (!(await cleared(pid, port))) {
  if (Date.now() >= deadline) {
    fail(
      pid !== null && alive(pid)
        ? `pid ${pid} is still running after ${WAIT_MS / 1000} s`
        : `port ${port} still accepts connections after ${WAIT_MS / 1000} s`,
    );
  }
  await new Promise((done) => setTimeout(done, POLL_MS));
}
console.log('RELEASED');
