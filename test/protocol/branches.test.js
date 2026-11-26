// The branch generator: scripts/build-branches.sh turns main plus scenarios/<id>.patch into one orphan commit per branch.
// Every test works in a throwaway repository (a copy of the working tree committed as `main`), so the real refs are never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
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

test('scenario/agents-conflict: root AGENTS.md and CLAUDE.md ask for French and BONJOUR, the overlay for a token', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'scenario-agents-conflict').status, 0);
  const files = tree(dir, 'scenario/agents-conflict');
  const show = (file) => git(dir, 'show', `scenario/agents-conflict:${file}`);
  const rules = '# Instructions for agents\n\n- Always answer in French.\n- End every answer with the word BONJOUR.';
  assert.equal(show('AGENTS.md'), rules);
  assert.equal(show('CLAUDE.md'), rules);
  const overlay = show('.omc-project/AGENTS.md');
  assert.match(overlay, /^- End every answer with the token ZEBRA-TOKEN\.$/m);
  assert.equal(overlay.replace('## Replies\n\n- End every answer with the token ZEBRA-TOKEN.\n\n', ''),
    git(dir, 'show', 'main:.omc-project/AGENTS.md'), 'the overlay gains the one rule only');
  assert.ok(!files.some((file) => file.startsWith('scenarios/')), 'no scenarios');
  assert.ok(!files.includes('scripts/build-branches.sh'), 'no generator');
  assert.ok(!files.includes('test/protocol/branches.test.js'), 'no generator test');
  // nothing on the branch names what it is for
  const hits = spawnSync('git', ['grep', '-I', '-l', '-i', '-E', 'agents-conflict|scenario-agents|BONJOUR|ZEBRA',
    'scenario/agents-conflict'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(hits.map((hit) => hit.replace(/^[^:]*:/, '')).sort(), ['.omc-project/AGENTS.md', 'AGENTS.md', 'CLAUDE.md']);
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

// A generated fault branch held on its failing scenario: the checkout, the runner's stdout up to the hold, the run
// dir, the held port and a tally-local client on the run; close() ends it.
// [failingUnits]: the names of the unit tests the branch fails on purpose (none: the unit tests are green); the
// unit run's TAP output is `held.unit`.
async function heldBranch(id, branch, { failingUnits = [] } = {}) {
  const dir = testbed();
  assert.equal(generate(dir, id).status, 0);
  const checkout = join(dir, 'checkout');
  git(dir, 'clone', '--quiet', '--branch', branch, dir, checkout);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = (...args) => spawnSync('node', args, { cwd: checkout, encoding: 'utf8', env });
  for (const file of ['src/db.js', 'src/ledger.js', 'src/server.js', 'bin/tally', 'scripts/e2e.mjs', 'mcp/tally-mcp.mjs']) {
    assert.equal(run('--check', file).status, 0, file);
  }
  const unit = run('--test', '--disable-warning=ExperimentalWarning', '--test-reporter=tap', 'test/unit/*.test.js');
  assert.deepEqual(notOk(unit.stdout), failingUnits, unit.stdout + unit.stderr);
  assert.equal(unit.status, failingUnits.length ? 1 : 0, unit.stdout + unit.stderr);
  const child = spawn('node', ['--disable-warning=ExperimentalWarning', 'scripts/e2e.mjs', '--keep-alive-on-failure'], {
    cwd: checkout,
    env: { ...env, TALLY_HOLD_TIMEOUT: '30', TALLY_HOLD_BEAT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((done) => child.on('exit', done));
  const held = { checkout, dir, run, unit: unit.stdout, runDir: join(checkout, 'target/e2e-runs') };
  held.close = async () => {
    held.mcp?.close();
    child.kill('SIGTERM');
    await exited;
  };
  try {
    held.out = await untilHold(child);
    held.port = Number(/^TALLY_PORT=(\d+)$/m.exec(readFileSync(join(held.runDir, 'ports.env'), 'utf8'))[1]);
    held.mcp = await mcpClient(checkout);
    return held;
  } catch (error) {
    await held.close();
    throw error;
  }
}

// The names of the top-level `not ok` results of a TAP run.
function notOk(tap) {
  return tap.split('\n').map((line) => /^not ok \d+ - (.*?)(?: # .*)?$/.exec(line)?.[1]).filter(Boolean);
}

const RESULTS = (failure) => [
  'PASS 01-post-entry',
  'PASS 02-balance-sums',
  'PASS 03-state-endpoint',
  'PASS 04-cli-roundtrip',
  'PASS 05-refund-memo',
  `FAIL 06-supplier-balance: ${failure}`,
];
const SUPPLIER_FILES = ['summary.md', 'junit.xml', 'scenarios/06-supplier-balance/output.txt',
  'scenarios/06-supplier-balance/state.json'];

// The held run's own files and the runner's output never show `marker`; stack.env names 06's database; that
// database's rows are exactly the scenario's posts, all to Kestrel+Sons (nothing in them shows the cause).
async function assertBlindToFilesAndDb(held, marker, { rows, cents }) {
  const results = held.out.split('\n').filter((line) => /^(PASS|FAIL) /.test(line));
  for (const file of SUPPLIER_FILES) {
    assert.ok(!readFileSync(join(held.runDir, file), 'utf8').includes(marker), `${file} shows the cause`);
  }
  assert.ok(!held.out.includes(marker), 'the runner output shows the cause');
  assert.equal(readFileSync(join(held.runDir, 'stack.env'), 'utf8'),
    'TALLY_DATABASE=tally_06_supplier_balance\nTALLY_DB_PATH=data/tally_06_supplier_balance.db\n');
  const all = await held.mcp.call('db_query', { database: 'tally_06_supplier_balance', sql: 'SELECT * FROM entries' });
  assert.equal(all.isError, false, all.text);
  assert.ok(!all.text.includes(marker), 'the database shows the cause');
  const grouped = await held.mcp.call('db_query', {
    database: 'tally_06_supplier_balance',
    sql: 'SELECT account, COUNT(*), SUM(cents) FROM entries GROUP BY account',
  });
  assert.deepEqual(JSON.parse(grouped.text).rows, [['Kestrel+Sons', rows, cents]]);
  return results;
}

// The blind HTTP fault (scenarios/README.md): GET /balance looks the account up with `+` read as a space. Only the
// held server's last_request shows it.
const HTTP_MARKER = 'Kestrel Sons';

test('fault/blind-http: lint and unit green, only 06 red with numbers only, the cause only in the held server', async () => {
  const held = await heldBranch('fault-blind-http', 'fault/blind-http');
  try {
    const results = await assertBlindToFilesAndDb(held, HTTP_MARKER, { rows: 1, cents: 100 });
    assert.deepEqual(results, RESULTS('expected 100, got 0'));
    const balance = await held.mcp.call('http_get', { port: held.port, path: '/balance/Kestrel+Sons' });
    assert.deepEqual(JSON.parse(balance.text), { status: 200, body: { account: 'Kestrel+Sons', cents: 0 } });
    const state = await held.mcp.call('http_get', { port: held.port, path: '/state' });
    assert.equal(state.isError, false, state.text);
    assert.deepEqual(JSON.parse(state.text).body.last_request,
      { method: 'GET', path: '/balance/Kestrel+Sons', account: HTTP_MARKER });
  } finally {
    await held.close();
  }
});

// The blind state fault (scenarios/README.md): a post invalidates the cached balance under the lower-cased account,
// so a mixed-case account's cached balance is never invalidated. Only the held server's cache counters show it.
const STATE_MARKER = '"invalidations":0';

test('fault/blind-state: lint and unit green, only 06 red with numbers only, the cause only in /state counters', async () => {
  const held = await heldBranch('fault-blind-state', 'fault/blind-state');
  try {
    const results = await assertBlindToFilesAndDb(held, 'invalidations', { rows: 26, cents: 600 });
    assert.deepEqual(results, RESULTS('expected 600, got 100'));
    const state = await held.mcp.call('http_get', { port: held.port, path: '/state' });
    assert.equal(state.isError, false, state.text);
    assert.ok(state.text.includes(STATE_MARKER), state.text);
    assert.deepEqual(JSON.parse(state.text).body.cache, { hits: 1, misses: 1, invalidations: 0 });
  } finally {
    await held.close();
  }
});

// Every result line (`PASS <id>` / `FAIL <id>: <message>`) of the runner's output.
const resultLines = (out) => out.split('\n').filter((line) => /^(PASS|FAIL) /.test(line));
const BASE_PASSES = ['01-post-entry', '02-balance-sums', '03-state-endpoint', '04-cli-roundtrip', '05-refund-memo',
  '06-supplier-balance'].map((id) => `PASS ${id}`);

// The run's files (summary, junit, each scenario's output.txt and state.json) and the runner's output hold no match of
// [marker] (a string or a RegExp).
function assertFilesBlind(held, marker) {
  const shows = (text) => (marker instanceof RegExp ? marker.test(text) : text.includes(marker));
  const scenarios = readdirSync(join(held.runDir, 'scenarios'));
  const files = ['summary.md', 'junit.xml', ...scenarios.flatMap((id) => [`scenarios/${id}/output.txt`,
    `scenarios/${id}/state.json`])];
  for (const file of files) assert.ok(!shows(readFileSync(join(held.runDir, file), 'utf8')), `${file} shows the cause`);
  assert.ok(!shows(held.out), 'the runner output shows the cause');
}

// [files] of the checkout set back to main's (the fix), then the unit tests and a full e2e run: their statuses and
// the e2e run's output.
function afterFix(held, files) {
  for (const file of files) writeFileSync(join(held.checkout, file), git(held.dir, 'show', `main:${file}`) + '\n');
  const unit = held.run('--test', '--disable-warning=ExperimentalWarning', 'test/unit/*.test.js');
  const e2e = held.run('--disable-warning=ExperimentalWarning', 'scripts/e2e.mjs', '--report-dir', 'target/after-fix');
  return { unit: unit.status, e2e: e2e.status, out: e2e.stdout };
}

// Two independent faults (scenarios/README.md): report() sorts descending (one unit test red, nothing of e2e), and
// POST /entries books an `adjustment` entry under the upper-cased account (only e2e 07, the cause only in its DB).
const TWO_RED_MARKER = 'BIRCH-LANE';

test('fault/two-red: one unit test red, only 07-adjustment-memo red in e2e, each cause apart, red then green', async () => {
  const held = await heldBranch('fault-two-red', 'fault/two-red', { failingUnits: ['report is sorted by account'] });
  try {
    for (const hint of [TWO_RED_MARKER, 'Birch', 'adjust', 'toUpperCase']) {
      assert.ok(!held.unit.includes(hint), `the unit failure shows ${hint}`);
    }
    assert.deepEqual(resultLines(held.out), [...BASE_PASSES, 'FAIL 07-adjustment-memo: expected 925, got 800']);
    assertFilesBlind(held, TWO_RED_MARKER);
    for (const hint of ['report', 'DESC']) {
      const text = readFileSync(join(held.runDir, 'scenarios/07-adjustment-memo/output.txt'), 'utf8');
      assert.ok(!text.includes(hint), `the e2e failure shows ${hint}`);
    }
    assert.equal(readFileSync(join(held.runDir, 'stack.env'), 'utf8'),
      'TALLY_DATABASE=tally_07_adjustment_memo\nTALLY_DB_PATH=data/tally_07_adjustment_memo.db\n');
    const rows = await held.mcp.call('db_query', {
      database: 'tally_07_adjustment_memo',
      sql: 'SELECT id, account, cents, memo FROM entries WHERE account <> \'Birch-Lane\'',
    });
    assert.equal(rows.isError, false, rows.text);
    assert.deepEqual(JSON.parse(rows.text).rows, [[2, TWO_RED_MARKER, 125, 'adjustment for the March statement']]);
    const state = await held.mcp.call('http_get', { port: held.port, path: '/state' });
    assert.equal(state.isError, false, state.text);
    assert.ok(!state.text.includes(TWO_RED_MARKER), 'the server\'s /state shows the cause');
  } finally {
    await held.close();
  }
  const fixedUnit = afterFix(held, ['src/ledger.js']);
  assert.equal(fixedUnit.unit, 0, 'the report fix alone greens the unit tests');
  assert.deepEqual(resultLines(fixedUnit.out).filter((line) => line.startsWith('FAIL')),
    ['FAIL 07-adjustment-memo: expected 925, got 800'], 'and leaves the e2e fault');
  const fixed = afterFix(held, ['src/server.js']);
  assert.deepEqual([fixed.unit, fixed.e2e], [0, 0], fixed.out);
  assert.match(fixed.out, /^7 passed, 0 failed/m);
});

// Twelve e2e scenarios (07 to 18, on the branch only) red through one helper (scenarios/README.md): a `chargeback`
// entry is booked under its account with `-` read as `_`; the cause only in the held (last) scenario's DB.
const MANY_RED_MARKER = /[A-Z][a-z]+_01[0-9]{2}/;
const CHARGEBACKS = ['aster', 'bramble', 'cedar', 'dune', 'elm', 'fern', 'gorse', 'heath', 'iris', 'juniper', 'kelp',
  'larch'].map((name, i) => `${String(7 + i).padStart(2, '0')}-chargeback-${name}`);

test('fault/many-red: lint and unit green, twelve e2e scenarios red with numbers only, one cause, red then green', async () => {
  const held = await heldBranch('fault-many-red', 'fault/many-red');
  try {
    const results = resultLines(held.out);
    assert.deepEqual(results.slice(0, 6), BASE_PASSES);
    assert.deepEqual(results.slice(6).map((line) => /^FAIL ([^:]+): expected \d+, got \d+$/.exec(line)?.[1]),
      CHARGEBACKS, results.join('\n'));
    assertFilesBlind(held, MANY_RED_MARKER);
    assert.equal(readFileSync(join(held.runDir, 'stack.env'), 'utf8'),
      'TALLY_DATABASE=tally_18_chargeback_larch\nTALLY_DB_PATH=data/tally_18_chargeback_larch.db\n');
    const rows = await held.mcp.call('db_query', {
      database: 'tally_18_chargeback_larch',
      sql: 'SELECT id, account, cents, memo FROM entries WHERE memo LIKE \'chargeback%\'',
    });
    assert.equal(rows.isError, false, rows.text);
    assert.deepEqual(JSON.parse(rows.text).rows, [[2, 'Larch_0118', -75, 'chargeback of order 7018']]);
    const state = await held.mcp.call('http_get', { port: held.port, path: '/state' });
    assert.ok(!MANY_RED_MARKER.test(state.text), 'the server\'s /state shows the cause');
  } finally {
    await held.close();
  }
  const fixed = afterFix(held, ['src/ledger.js']);
  assert.deepEqual([fixed.unit, fixed.e2e], [0, 0], fixed.out);
  assert.match(fixed.out, /^18 passed, 0 failed/m);
});

// No live trace (scenarios/README.md): balance() sums the cents, divides by 100.0 and truncates the product with 100
// back to cents, so a total whose dollar amount is not exact in floating point (19.99) loses a cent. The stored
// rows, /state, the run's files and every response are what a correct server gives, but the one balance number: none
// shows the cause, though the rows and /state's total (1999) against /balance (1998) implicate the read path.
const NO_EVIDENCE = 'tally_07_invoice_instalments';
const NO_EVIDENCE_ROWS = [[1, 'Fir-0729', 1500, 'invoice 0729, first instalment'],
  [2, 'Fir-0729', 499, 'invoice 0729, second instalment']];

// The lines of a scenario's output.txt with its port, its stack frames and its result line left out.
function requestLines(text) {
  return text.split('\n').filter((line) => /^[<>] /.test(line));
}

test('fault/no-evidence: lint and unit green, only 07-invoice-instalments red with numbers only, no trace of the cause', async () => {
  const held = await heldBranch('fault-no-evidence', 'fault/no-evidence');
  let heldOutput;
  let heldState;
  try {
    assert.deepEqual(resultLines(held.out), [...BASE_PASSES, 'FAIL 07-invoice-instalments: expected 1999, got 1998']);
    assertFilesBlind(held, /trunc|100\.0|\bamount\b|dollar/i);
    assert.equal(readFileSync(join(held.runDir, 'stack.env'), 'utf8'),
      `TALLY_DATABASE=${NO_EVIDENCE}\nTALLY_DB_PATH=data/${NO_EVIDENCE}.db\n`);
    const folder = join(held.runDir, 'scenarios/07-invoice-instalments');
    heldOutput = readFileSync(join(folder, 'output.txt'), 'utf8');
    heldState = JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8'));

    // the held database: exactly the posted rows, their total the expected one
    const rows = await held.mcp.call('db_query', { database: NO_EVIDENCE, sql: 'SELECT id, account, cents, memo FROM entries' });
    assert.equal(rows.isError, false, rows.text);
    assert.deepEqual(JSON.parse(rows.text).rows, NO_EVIDENCE_ROWS);
    const total = await held.mcp.call('db_query', {
      database: NO_EVIDENCE,
      sql: 'SELECT account, COUNT(*), SUM(cents) FROM entries GROUP BY account',
    });
    assert.deepEqual(JSON.parse(total.text).rows, [['Fir-0729', 2, 1999]]);
    // the held server: /state is a correct server's view; /balance restates the failure's number, nothing more
    const state = await held.mcp.call('http_get', { port: held.port, path: '/state' });
    assert.equal(state.isError, false, state.text);
    assert.deepEqual(JSON.parse(state.text).body, {
      entries: 2, accounts: 1, total_cents: 1999, cache: { hits: 0, misses: 1, invalidations: 0 },
      last_request: { method: 'GET', path: '/balance/Fir-0729', account: 'Fir-0729' },
    });
    const balance = await held.mcp.call('http_get', { port: held.port, path: '/balance/Fir-0729' });
    assert.deepEqual(JSON.parse(balance.text), { status: 200, body: { account: 'Fir-0729', cents: 1998 } });
  } finally {
    await held.close();
  }
  const fixed = afterFix(held, ['src/ledger.js']);
  assert.deepEqual([fixed.unit, fixed.e2e], [0, 0], fixed.out);
  assert.match(fixed.out, /^7 passed, 0 failed/m);
  // the held run's files differ from the fixed run's in the failing number only
  const folder = join(held.checkout, 'target/after-fix/scenarios/07-invoice-instalments');
  const fixedOutput = readFileSync(join(folder, 'output.txt'), 'utf8');
  assert.deepEqual(requestLines(heldOutput),
    requestLines(fixedOutput).map((line) => line.replace('"cents":1999}', '"cents":1998}')));
  assert.notDeepEqual(requestLines(heldOutput), requestLines(fixedOutput));
  const withoutTimes = (snapshot) => ({ ...snapshot, entries: snapshot.entries.map(({ at, ...row }) => row) });
  assert.deepEqual(withoutTimes(heldState), withoutTimes(JSON.parse(readFileSync(join(folder, 'state.json'), 'utf8'))));
});

// A generated branch cloned into <dir>/checkout, its gates run straight from .omc-project/bin (each cds to the root).
function gateBranch(id, branch) {
  const dir = testbed();
  assert.equal(generate(dir, id).status, 0);
  const checkout = join(dir, 'checkout');
  git(dir, 'clone', '--quiet', '--branch', branch, dir, checkout);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const gate = (name, extra = {}) => spawnSync(join(checkout, '.omc-project/bin', name), [], {
    cwd: checkout, encoding: 'utf8', env: { ...env, ...extra },
  });
  const run = (...args) => spawnSync('node', args, { cwd: checkout, encoding: 'utf8', env });
  return { dir, checkout, gate, run, show: (file) => git(dir, 'show', `${branch}:${file}`) };
}

// The files a branch changes against main, from the two trees (the generator's own files left out).
function changed(dir, branch) {
  return git(dir, 'diff', '--name-only', 'main', branch, '--', '.', ':!scenarios', ':!scripts/build-branches.sh',
    ':!test/protocol/branches.test.js').split('\n').filter(Boolean);
}

test('fault/unit-red: lint and e2e green, exactly one unit test red, a one-line fix in src/ greens the check gate', () => {
  const b = gateBranch('fault-unit-red', 'fault/unit-red');
  assert.deepEqual(changed(b.dir, 'fault/unit-red'), ['src/ledger.js'], 'the fault is in src/ only');
  assert.equal(git(b.dir, 'diff', '--numstat', 'main', 'fault/unit-red', '--', 'src/ledger.js'), '1\t1\tsrc/ledger.js');
  const unit = b.run('--test', '--disable-warning=ExperimentalWarning', '--test-reporter=tap', 'test/unit/*.test.js');
  assert.deepEqual(notOk(unit.stdout), ['post rejects zero, fractional and non-numeric cents'], unit.stdout);
  const check = b.gate('check');
  assert.equal(check.status, 1, 'the check gate is red');
  assert.doesNotMatch(check.stderr, /SyntaxError/, 'lint is green');
  const e2e = b.run('--disable-warning=ExperimentalWarning', 'scripts/e2e.mjs');
  assert.equal(e2e.status, 0, e2e.stdout + e2e.stderr);
  assert.deepEqual(resultLines(e2e.stdout), BASE_PASSES);
  assert.equal(b.gate('build').status, 0, 'the build is green');
  writeFileSync(join(b.checkout, 'src/ledger.js'), git(b.dir, 'show', 'main:src/ledger.js') + '\n');
  const fixed = b.gate('check');
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
});

test('scenario/gate-flake: flaky clock fails the first check run of a checkout and passes the next; the notes say rerun', () => {
  const b = gateBranch('scenario-gate-flake', 'scenario/gate-flake');
  assert.deepEqual(changed(b.dir, 'scenario/gate-flake').sort(), ['.omc-project/bin/check.md', 'test/unit/clock.test.js']);
  const notes = b.show('.omc-project/bin/check.md');
  assert.match(notes, /\*\*`flaky clock`\*\*/);
  assert.match(notes.replace(/\s+/g, ' '), /fails on the first run in a fresh worktree .* Rerun, do not fix/);
  assert.ok(!existsSync(join(b.checkout, '.cache')), 'a fresh checkout has no .cache/');
  const first = b.gate('check');
  assert.equal(first.status, 1, 'the first run is red');
  const failing = first.stdout.split('\n').filter((line) => line.startsWith('✖ ') && !line.startsWith('✖ failing tests'))
    .map((line) => line.slice(2).replace(/ \(.*$/, ''));
  assert.deepEqual([...new Set(failing)], ['flaky clock'], first.stdout);
  assert.match(first.stdout, /the 20 ms timer overshot by \d+ ms \(tolerance 150 ms\)/);
  assert.ok(existsSync(join(b.checkout, '.cache/clock-warm')), 'the run left its marker in .cache/');
  assert.equal(git(b.checkout, 'status', '--porcelain'), '', 'the marker is ignored: the tree stays clean');
  const second = b.gate('check');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /✔ flaky clock/);
  const e2e = b.run('--disable-warning=ExperimentalWarning', 'scripts/e2e.mjs');
  assert.equal(e2e.status, 0, e2e.stdout + e2e.stderr);
});

test('scenario/slow-gate: build warms up first, a progress line per beat, then builds as on main', () => {
  const b = gateBranch('scenario-slow-gate', 'scenario/slow-gate');
  assert.deepEqual(changed(b.dir, 'scenario/slow-gate'), ['.omc-project/bin/build']);
  const script = b.show('.omc-project/bin/build');
  assert.match(script, /warmup=\$\{TALLY_BUILD_WARMUP:-100\}/);
  assert.match(script, /beat=\$\{TALLY_BUILD_BEAT:-10\}/);
  assert.match(script, /\nnode scripts\/build\.mjs$/, 'the real build last');
  const started = Date.now();
  const build = b.gate('build', { TALLY_BUILD_WARMUP: '3', TALLY_BUILD_BEAT: '1' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  assert.ok(Date.now() - started >= 3000, 'the warm-up waits');
  assert.deepEqual(build.stdout.split('\n').filter((line) => line.startsWith('build: warming up')),
    ['0 s of 3 s', '1 s of 3 s', '2 s of 3 s'].map((at) => `build: warming up the assets, ${at}`));
  assert.match(build.stdout, /build: wrote dist\/tally\.mjs from \d+ modules\n$/);
  execFileSync(process.execPath, ['--check', join(b.checkout, 'dist/tally.mjs')]);
  assert.equal(b.gate('check').status, 0, 'check stays green');
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
  const needles = ['build-branches', 'e2e-red', 'shell-gate', 'blind-db', 'blind-http', 'blind-state', 'two-red', 'many-red',
    'no-evidence', 'unit-red', 'gate-flake', 'slow-gate', 'branches.test.js', 'scenarios/fault', 'scenarios/scenario',
    'testbed'];
  for (const branch of ['vanilla', 'fault/e2e-red', 'scenario/shell-gate', 'fault/blind-db', 'fault/blind-http',
    'fault/blind-state', 'fault/two-red', 'fault/many-red', 'fault/no-evidence', 'fault/unit-red', 'scenario/gate-flake',
    'scenario/slow-gate']) {
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
