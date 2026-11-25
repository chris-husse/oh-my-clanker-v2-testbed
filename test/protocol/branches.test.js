// The branch generator: scripts/build-branches.sh turns main plus scenarios/<id>.patch into one orphan commit per branch.
// Every test works in a throwaway repository (a copy of the working tree committed as `main`), so the real refs are never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dirs = new Set();

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// The working tree (tracked and untracked files, ignored ones left out) committed as `main` of a fresh repository.
function testbed() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-branches-'));
  dirs.add(dir);
  const files = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter((file) => file && existsSync(join(root, file)));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, file));
    chmodSync(join(dir, file), statSync(join(root, file)).mode);
  }
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'main');
  return dir;
}

function generate(dir, ...args) {
  return spawnSync('bash', ['scripts/build-branches.sh', ...args], { cwd: dir, encoding: 'utf8' });
}

function tree(dir, ref) {
  return git(dir, 'ls-tree', '-r', '--name-only', ref).split('\n');
}

test('two runs give the same commit ids', () => {
  const dir = testbed();
  const first = generate(dir, 'vanilla', 'fault-e2e-red');
  assert.equal(first.status, 0, first.stderr);
  const ids = ['vanilla', 'fault/e2e-red'].map((branch) => git(dir, 'rev-parse', branch));
  git(dir, 'update-ref', '-d', 'refs/heads/vanilla');
  git(dir, 'update-ref', '-d', 'refs/heads/fault/e2e-red');
  const second = generate(dir, 'vanilla', 'fault-e2e-red');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(['vanilla', 'fault/e2e-red'].map((branch) => git(dir, 'rev-parse', branch)), ids);
});

test('a generated branch is one orphan commit with a fixed author and date', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'fault-e2e-red').status, 0);
  assert.equal(git(dir, 'rev-list', '--count', 'fault/e2e-red'), '1');
  assert.equal(git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%aI|%cI|%s', 'fault/e2e-red'), [
    'tally testbed <testbed@example.invalid>',
    'tally testbed <testbed@example.invalid>',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    'scenario fault-e2e-red',
  ].join('|'));
});

test('generating leaves the caller checkout, index and main alone', () => {
  const dir = testbed();
  const before = [git(dir, 'rev-parse', 'main'), git(dir, 'status', '--porcelain'), git(dir, 'symbolic-ref', 'HEAD')];
  assert.equal(generate(dir).status, 0);
  assert.deepEqual([git(dir, 'rev-parse', 'main'), git(dir, 'status', '--porcelain'), git(dir, 'symbolic-ref', 'HEAD')], before);
});

test('vanilla is main without the overlay, the scenarios and the generator', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'vanilla').status, 0);
  const files = tree(dir, 'vanilla');
  assert.ok(files.includes('src/ledger.js'));
  assert.ok(files.includes('scripts/e2e.mjs'));
  assert.ok(!files.some((file) => file.startsWith('.omc-project/')), 'no .omc-project');
  assert.ok(!files.some((file) => file.startsWith('scenarios/')), 'no scenarios');
  assert.ok(!files.includes('scripts/build-branches.sh'), 'no generator');
});

test('fault/e2e-red keeps the overlay and hides the scenarios and the generator', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'fault-e2e-red').status, 0);
  const files = tree(dir, 'fault/e2e-red');
  assert.ok(files.includes('.omc-project/bin/verify'));
  assert.ok(!files.some((file) => file.startsWith('scenarios/')), 'no scenarios');
  assert.ok(!files.includes('scripts/build-branches.sh'), 'no generator');
  assert.equal(git(dir, 'ls-tree', 'fault/e2e-red', '.omc-project/bin/verify').split(' ')[0], '100755');
});

test('fault/e2e-red fails the e2e run and passes the unit tests and the syntax check', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'fault-e2e-red').status, 0);
  const checkout = join(dir, 'checkout');
  git(dir, 'clone', '--quiet', '--branch', 'fault/e2e-red', dir, checkout);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = (...args) => spawnSync('node', args, { cwd: checkout, encoding: 'utf8', env });
  const e2e = run('scripts/e2e.mjs');
  assert.notEqual(e2e.status, 0, 'the e2e run must fail');
  assert.match(e2e.stdout + e2e.stderr, /expected 1000, got \d+/);
  assert.match(e2e.stdout + e2e.stderr, /02-balance-sums/);
  const unit = run('--test', '--disable-warning=ExperimentalWarning', 'test/unit/*.test.js');
  assert.equal(unit.status, 0, unit.stdout + unit.stderr);
  assert.equal(run('--check', 'src/ledger.js').status, 0);
});

test('scenario/shell-gate: verify is a POSIX shell script with no node helper and keeps the overlay contract', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'scenario-shell-gate').status, 0);
  const checkout = join(dir, 'checkout');
  git(dir, 'clone', '--quiet', '--branch', 'scenario/shell-gate', dir, checkout);
  const verify = git(checkout, 'show', 'HEAD:.omc-project/bin/verify');
  assert.match(verify, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(verify, /failed\.mjs|node -e|\[\[ |declare |local /, 'no node helper, no bash-only syntax');
  assert.match(verify, /sh omc\/bin\/unit\.sh/);
  assert.match(verify, /sh omc\/bin\/e2e\.sh/);
  assert.equal(spawnSync('sh', ['-n', '.omc-project/bin/verify'], { cwd: checkout }).status, 0, 'parses as sh');
  // the overlay's own contract tests (records, --failed-only, the hold) run against the shell gate
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = spawnSync('node', ['--test', '--disable-warning=ExperimentalWarning', 'test/protocol/overlay.test.js'], {
    cwd: checkout,
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

// The blind DB fault (scenarios/README.md): a refund's account is stored lower-cased. Only the held database shows it.
const BLIND_MARKER = 'acme-7731';

// A JSON-RPC client of mcp/tally-mcp.mjs started in `cwd`: call(name, args) -> the tool's text, isError.
async function mcpClient(cwd) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(cwd, 'mcp/tally-mcp.mjs')], {
    cwd,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let buffer = '';
  let next = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line) pending.get(JSON.parse(line).id)?.(JSON.parse(line));
  });
  const rpc = (method, params) => new Promise((done) => {
    const id = next++;
    pending.set(id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    call: async (name, args) => {
      const { result } = await rpc('tools/call', { name, arguments: args });
      return { text: result.content[0].text, isError: Boolean(result.isError) };
    },
    close: () => child.kill('SIGKILL'),
  };
}

// Resolves with the runner's stdout once it printed `OMC_HOLD <dir>`.
function untilHold(child) {
  return new Promise((done, fail) => {
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (/^OMC_HOLD /m.test(out)) done(out);
    });
    child.on('exit', (code) => fail(new Error(`the runner exited ${code} without holding:\n${out}`)));
  });
}

test('fault/blind-db: lint and unit green, only 05-refund-memo red with numbers only, the cause only in the held DB', async () => {
  const dir = testbed();
  assert.equal(generate(dir, 'fault-blind-db').status, 0);
  const checkout = join(dir, 'checkout');
  git(dir, 'clone', '--quiet', '--branch', 'fault/blind-db', dir, checkout);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = (...args) => spawnSync('node', args, { cwd: checkout, encoding: 'utf8', env });

  for (const file of ['src/db.js', 'src/ledger.js', 'src/server.js', 'bin/tally', 'scripts/e2e.mjs', 'mcp/tally-mcp.mjs']) {
    assert.equal(run('--check', file).status, 0, file);
  }
  const unit = run('--test', '--disable-warning=ExperimentalWarning', 'test/unit/*.test.js');
  assert.equal(unit.status, 0, unit.stdout + unit.stderr);

  const child = spawn('node', ['--disable-warning=ExperimentalWarning', 'scripts/e2e.mjs', '--keep-alive-on-failure'], {
    cwd: checkout,
    env: { ...env, TALLY_HOLD_TIMEOUT: '30', TALLY_HOLD_BEAT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((done) => child.on('exit', done));
  let mcp;
  try {
    const out = await untilHold(child);
    const results = out.split('\n').filter((line) => /^(PASS|FAIL) /.test(line));
    assert.deepEqual(results, [
      'PASS 01-post-entry',
      'PASS 02-balance-sums',
      'PASS 03-state-endpoint',
      'PASS 04-cli-roundtrip',
      'FAIL 05-refund-memo: expected 1050, got 600',
      'PASS 06-supplier-balance',
    ]);

    // the files of the run carry the numbers, never the cause
    const runDir = join(checkout, 'target/e2e-runs');
    const files = ['summary.md', 'junit.xml', 'scenarios/05-refund-memo/output.txt', 'scenarios/05-refund-memo/state.json'];
    for (const file of files) {
      assert.ok(!readFileSync(join(runDir, file), 'utf8').includes(BLIND_MARKER), `${file} shows the cause`);
    }
    assert.ok(!out.includes(BLIND_MARKER), 'the runner output shows the cause');
    assert.equal(readFileSync(join(runDir, 'stack.env'), 'utf8'),
      'TALLY_DATABASE=tally_05_refund_memo\nTALLY_DB_PATH=data/tally_05_refund_memo.db\n');
    const port = Number(/^TALLY_PORT=(\d+)$/m.exec(readFileSync(join(runDir, 'ports.env'), 'utf8'))[1]);

    // the held database and server, through tally-local, show it
    mcp = await mcpClient(checkout);
    const rows = await mcp.call('db_query', {
      database: 'tally_05_refund_memo',
      sql: "SELECT id, account, cents, memo FROM entries WHERE memo LIKE 'refund%'",
    });
    assert.equal(rows.isError, false, rows.text);
    assert.deepEqual(JSON.parse(rows.text).rows, [[2, BLIND_MARKER, 450, 'refund of invoice 7731']]);
    const balance = await mcp.call('http_get', { port, path: `/balance/${BLIND_MARKER}` });
    assert.equal(balance.isError, false, balance.text);
    assert.deepEqual(JSON.parse(balance.text), { status: 200, body: { account: BLIND_MARKER, cents: 450 } });
  } finally {
    mcp?.close();
    child.kill('SIGTERM');
    await exited;
  }
});

test('an unknown id exits non-zero with a message and creates nothing', () => {
  const dir = testbed();
  const result = generate(dir, 'no-such-scenario');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown scenario id: no-such-scenario/);
  assert.equal(git(dir, 'branch', '--list', '*no-such-scenario*'), '');
});

test('--push only pushes the generated branches, never main', () => {
  const dir = testbed();
  const remote = mkdtempSync(join(tmpdir(), 'tally-remote-'));
  dirs.add(remote);
  git(remote, 'init', '--quiet', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  const result = generate(dir, '--push', 'vanilla', 'fault-e2e-red');
  assert.equal(result.status, 0, result.stderr);
  const refs = git(remote, 'for-each-ref', '--format=%(refname)').split('\n').sort();
  assert.deepEqual(refs, ['refs/heads/fault/e2e-red', 'refs/heads/vanilla']);
});

test('generated trees hold no trace of the generator, its test or any scenario id', () => {
  const dir = testbed();
  assert.equal(generate(dir).status, 0);
  const needles = ['build-branches', 'e2e-red', 'shell-gate', 'blind-db', 'branches.test.js', 'scenarios/fault',
    'scenarios/scenario'];
  for (const branch of ['vanilla', 'fault/e2e-red', 'scenario/shell-gate', 'fault/blind-db']) {
    const files = tree(dir, branch);
    assert.ok(!files.includes('test/protocol/branches.test.js'), `${branch}: no generator test`);
    for (const file of files) {
      const text = git(dir, 'show', `${branch}:${file}`);
      for (const needle of needles) {
        if (file.startsWith('e2e/scenarios/')) continue;
        assert.ok(!text.includes(needle), `${branch}:${file} mentions ${needle}`);
      }
    }
  }
});

test('the generator runs from a subdirectory of the checkout', () => {
  const dir = testbed();
  mkdirSync(join(dir, 'src', 'deeper'), { recursive: true });
  const result = spawnSync('bash', [join(dir, 'scripts/build-branches.sh'), 'fault-e2e-red'], {
    cwd: join(dir, 'src', 'deeper'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(dir, 'rev-list', '--count', 'fault/e2e-red'), '1');
});

test('an id is matched literally, not as a pattern', () => {
  const dir = testbed();
  const result = generate(dir, 'fault-e2e-re.');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown scenario id/);
});
