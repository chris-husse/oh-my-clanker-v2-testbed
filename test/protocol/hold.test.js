import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = 'test/protocol/fixtures/*.mjs';
const children = new Set();
const dirs = new Set();

after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runDir() {
  mkdirSync(join(root, 'target'), { recursive: true });
  const dir = mkdtempSync(join(root, 'target', 'protocol-'));
  dirs.add(dir);
  return dir;
}

function startRunner(args, env = {}) {
  const child = spawn(process.execPath, ['scripts/e2e.mjs', ...args], {
    cwd: root,
    env: { ...process.env, TALLY_HOLD_BEAT: '1', TALLY_HOLD_TIMEOUT: '30', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.lines = [];
  child.holds = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const line of parts) {
      child.lines.push(line);
      if (line.startsWith('OMC_HOLD ')) child.holds.push({ line, at: Date.now() });
    }
  });
  child.stderr.resume();
  child.exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  return child;
}

async function until(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function exitWithin(child, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('runner did not exit')), timeoutMs);
  });
  try {
    return await Promise.race([child.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function envFile(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
}

function release(dir) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/release.mjs', '--report-dir', dir],
      { cwd: root, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

async function held(dir, args = ['--only', '90-red-balance'], env = {}) {
  const child = startRunner(['--features', FIXTURES, '--keep-alive-on-failure', '--report-dir', dir, ...args], env);
  await until(() => child.holds.length >= 1, 'the first OMC_HOLD line');
  return child;
}

test('a failed run holds: markers, beats, live service, then release', async () => {
  const dir = runDir();
  const child = await held(dir);
  try {
    assert.equal(child.holds[0].line, `OMC_HOLD ${dir}`);
    assert.equal(readFileSync(join(dir, 'harness.pid'), 'utf8'), `${child.pid}\n`);
    assert.equal(readFileSync(join(dir, 'harness.holding'), 'utf8'), `${child.pid}\n`);
    await until(() => child.holds.length >= 2, 'the second OMC_HOLD line', 5_000);
    assert.ok(child.holds[1].at - child.holds[0].at <= 3_000, 'second beat within 3 s');
    assert.equal(child.holds[1].line, `OMC_HOLD ${dir}`);
    assert.equal(child.lines.at(-1), `OMC_HOLD ${dir}`);

    const port = Number(envFile(join(dir, 'ports.env')).TALLY_PORT);
    const res = await fetch(`http://127.0.0.1:${port}/state`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { entries: 1, accounts: 1, total_cents: 1050 });

    assert.deepEqual(envFile(join(dir, 'stack.env')), {
      TALLY_DATABASE: 'tally_90_red_balance',
      TALLY_DB_PATH: 'data/tally_90_red_balance.db',
    });
    assert.ok(existsSync(join(root, 'data/tally_90_red_balance.db')));
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /\| FAIL \| 90-red-balance \| .+ \| \[folder\]\(scenarios\/90-red-balance\/\) \|/);
    const output = readFileSync(join(dir, 'scenarios/90-red-balance/output.txt'), 'utf8');
    assert.match(output, /expected 10500, got 1050/);
    const state = JSON.parse(readFileSync(join(dir, 'scenarios/90-red-balance/state.json'), 'utf8'));
    assert.deepEqual(state.state, { entries: 1, accounts: 1, total_cents: 1050 });
    assert.equal(state.entries.length, 1);
    assert.match(readFileSync(join(dir, 'junit.xml'), 'utf8'), /<failure message="expected 10500, got 1050"/);

    const first = await release(dir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout.trim(), 'RELEASED');
    assert.equal(pidAlive(child.pid), false);
    assert.equal(await portIsOpen(port), false);
    assert.equal(existsSync(join(dir, 'harness.pid')), false);
    assert.equal(existsSync(join(dir, 'harness.holding')), false);
    assert.equal((await exitWithin(child)).code, 1);

    const second = await release(dir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout.trim(), 'RELEASED');
  } finally {
    child.kill('SIGKILL');
  }
});

test('the last failed scenario is the one held', async () => {
  const dir = runDir();
  const child = await held(dir, []);
  try {
    assert.equal(envFile(join(dir, 'stack.env')).TALLY_DATABASE, 'tally_91_red_state');
    const port = Number(envFile(join(dir, 'ports.env')).TALLY_PORT);
    const res = await fetch(`http://127.0.0.1:${port}/state`);
    assert.equal((await res.json()).total_cents, 1);
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /\| FAIL \| 90-red-balance \|/);
    assert.match(summary, /\| FAIL \| 91-red-state \|/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('TALLY_BACKDATE_HOLD moves the hold start into the past', async () => {
  const dir = runDir();
  const child = await held(dir, ['--only', '90-red-balance'], { TALLY_BACKDATE_HOLD: '1300' });
  try {
    const age = (Date.now() - statSync(join(dir, 'harness.pid')).mtimeMs) / 1000;
    assert.ok(age >= 1295 && age <= 1310, `hold start is ${age} s ago`);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a passing run exits 0 and never holds', async () => {
  const dir = runDir();
  const child = startRunner(['--keep-alive-on-failure', '--report-dir', dir, '--only', '01-post-entry']);
  try {
    const { code } = await exitWithin(child);
    assert.equal(code, 0);
    assert.equal(child.holds.length, 0);
    assert.equal(existsSync(join(dir, 'harness.pid')), false);
    assert.equal(existsSync(join(dir, 'harness.holding')), false);
    assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /\| PASS \| 01-post-entry \|/);
    assert.equal(envFile(join(dir, 'stack.env')).TALLY_DATABASE, 'tally_01_post_entry');
  } finally {
    child.kill('SIGKILL');
  }
});

test('a failed run without --keep-alive-on-failure exits 1 and never holds', async () => {
  const dir = runDir();
  const child = startRunner(['--features', FIXTURES, '--report-dir', dir, '--only', '90-red-balance']);
  try {
    const { code } = await exitWithin(child);
    assert.equal(code, 1);
    assert.equal(child.holds.length, 0);
    assert.equal(existsSync(join(dir, 'harness.pid')), false);
    assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /\| FAIL \| 90-red-balance \|/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('the hold ends by itself after TALLY_HOLD_TIMEOUT', async () => {
  const dir = runDir();
  const child = await held(dir, ['--only', '90-red-balance'], { TALLY_HOLD_TIMEOUT: '2' });
  try {
    const port = Number(envFile(join(dir, 'ports.env')).TALLY_PORT);
    const { code } = await exitWithin(child, 8_000);
    assert.equal(code, 1);
    assert.equal(existsSync(join(dir, 'harness.pid')), false);
    assert.equal(existsSync(join(dir, 'harness.holding')), false);
    assert.equal(await portIsOpen(port), false);
  } finally {
    child.kill('SIGKILL');
  }
});

test('SIGTERM while held leaves no listener and no markers', async () => {
  const dir = runDir();
  const child = await held(dir);
  try {
    const port = Number(envFile(join(dir, 'ports.env')).TALLY_PORT);
    assert.equal(await portIsOpen(port), true);
    child.kill('SIGTERM');
    await exitWithin(child);
    assert.equal(await portIsOpen(port), false);
    assert.equal(existsSync(join(dir, 'harness.pid')), false);
    assert.equal(existsSync(join(dir, 'harness.holding')), false);
  } finally {
    child.kill('SIGKILL');
  }
});

test('release refuses a harness.pid naming a process that is not the runner', async () => {
  const dir = runDir();
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.add(stranger);
  try {
    writeFileSync(join(dir, 'harness.pid'), `${stranger.pid}\n`);
    writeFileSync(join(dir, 'ports.env'), 'TALLY_PORT=1\n');
    const result = await release(dir);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /RELEASED/);
    assert.match(result.stderr, new RegExp(`\\b${stranger.pid}\\b`));
    assert.equal(pidAlive(stranger.pid), true);
  } finally {
    stranger.kill('SIGKILL');
    children.delete(stranger);
  }
});
