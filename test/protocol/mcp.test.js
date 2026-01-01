import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/db.js';
import { startServer } from '../../src/server.js';
import { post } from '../../src/ledger.js';

const SERVER = fileURLToPath(new URL('../../mcp/tally-mcp.mjs', import.meta.url));
const children = new Set();
const dirs = new Set();
const closers = new Set();

after(async () => {
  for (const child of children) child.kill('SIGKILL');
  for (const close of closers) await close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempCwd() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-mcp-'));
  dirs.add(dir);
  mkdirSync(join(dir, 'data'));
  return dir;
}

function seed(cwd, name, rowCount = 3) {
  const db = new DatabaseSync(join(cwd, 'data', `${name}.db`));
  db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, account TEXT, cents INTEGER)');
  const insert = db.prepare('INSERT INTO entries (account, cents) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= rowCount; i++) insert.run(`acct${i}`, i * 100);
  db.exec('COMMIT');
  db.close();
}

function spawnServer(cwd, env = {}) {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SERVER],
    { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.add(child);
  child.pending = new Map();
  child.nonJson = [];
  child.nextId = 1;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const line of parts) {
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        child.nonJson.push(line);
        continue;
      }
      child.pending.get(message.id)?.(message);
    }
  });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('exit', () => {
    children.delete(child);
    for (const settle of child.pending.values()) settle({ error: { code: -1, message: 'server exited' } });
  });
  child.rpc = (method, params, timeoutMs = 10_000) => {
    const id = child.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      child.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  child.notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  child.call = async (name, args = {}) => {
    const reply = await child.rpc('tools/call', { name, arguments: args });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  return child;
}

async function started(cwd, env) {
  const child = spawnServer(cwd, env);
  const reply = await child.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(reply.result.serverInfo.name, 'tally-local');
  child.notify('notifications/initialized');
  return child;
}

const textOf = (result) => result.content[0].text;
const jsonOf = (result) => JSON.parse(textOf(result));

test('initialize echoes the protocol version and advertises tools', async () => {
  const child = spawnServer(tempCwd());
  const reply = await child.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  assert.equal(reply.jsonrpc, '2.0');
  assert.deepEqual(reply.result, {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'tally-local', version: '1.0.0' },
  });
  const fallback = await child.rpc('initialize', {});
  assert.equal(fallback.result.protocolVersion, '2024-11-05');
});

test('notifications get no answer and unknown methods are -32601', async () => {
  const child = await started(tempCwd());
  const reply = await child.rpc('bogus/method', {});
  assert.equal(reply.error.code, -32601);
  assert.deepEqual(child.nonJson, []);
});

test('tools/list declares the three tools with typed required fields', async () => {
  const child = await started(tempCwd());
  const { result } = await child.rpc('tools/list', {});
  const byName = Object.fromEntries(result.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName).sort(), ['db_query', 'http_get', 'server_info']);
  assert.deepEqual(byName.db_query.inputSchema.required.sort(), ['database', 'sql']);
  assert.equal(byName.db_query.inputSchema.properties.database.type, 'string');
  assert.equal(byName.db_query.inputSchema.properties.sql.type, 'string');
  assert.deepEqual(byName.http_get.inputSchema.required.sort(), ['path', 'port']);
  assert.equal(byName.http_get.inputSchema.properties.port.type, 'integer');
  assert.equal(byName.http_get.inputSchema.properties.path.type, 'string');
  for (const tool of result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('server_info reports the read-only identity and no databases key by default', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_real');
  const child = await started(cwd);
  const info = jsonOf(await child.call('server_info'));
  assert.deepEqual(info, {
    name: 'tally-local',
    database: { user: 'readonly' },
    tools: ['server_info', 'db_query', 'http_get'],
  });
  assert.equal('databases' in info, false);
});

test('decoy knob lists the decoy first, then the real databases', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_b_real');
  seed(cwd, 'tally_a_real');
  const child = await started(cwd, { TALLY_MCP_DECOY: '1' });
  const info = jsonOf(await child.call('server_info'));
  assert.deepEqual(info.databases, ['tally_decoy', 'tally_a_real', 'tally_b_real']);
});

test('db_query returns columns and rows from a seeded database', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_seeded');
  const child = await started(cwd);
  const result = await child.call('db_query', {
    database: 'tally_seeded',
    sql: '  -- note\n SELECT account, cents FROM entries ORDER BY id;  ',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(jsonOf(result), {
    columns: ['account', 'cents'],
    rows: [['acct1', 100], ['acct2', 200], ['acct3', 300]],
  });
});

test('db_query rejects writes even when the SQL starts with SELECT', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_seeded');
  const child = await started(cwd);
  for (const sql of [
    'DELETE FROM entries',
    'INSERT INTO entries (account, cents) VALUES (\'x\', 1)',
    'PRAGMA table_info(entries)',
    'ATTACH DATABASE \'x.db\' AS x',
    'SELECT 1; DROP TABLE entries',
    'SELECT 1; SELECT 2',
    'SELECT * FROM entries WHERE account = 1 OR replace(account, \'a\', \'b\') = \'b\'',
    '',
  ]) {
    const result = await child.call('db_query', { database: 'tally_seeded', sql });
    assert.equal(result.isError, true, sql);
    assert.match(textOf(result), /sql/, sql);
  }
  const intact = await child.call('db_query', {
    database: 'tally_seeded',
    sql: 'SELECT count(*) FROM entries',
  });
  assert.deepEqual(jsonOf(intact).rows, [[3]]);
});

test('db_query rejects a bad database name or a missing file naming database', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_seeded');
  seed(cwd, 'other_name');
  const child = await started(cwd);
  for (const database of ['../x', 'other_name', 'tally_Seeded', 'tally_', `tally_${'a'.repeat(70)}`, 'tally_x.db']) {
    const result = await child.call('db_query', { database, sql: 'SELECT 1' });
    assert.equal(result.isError, true, database);
    assert.match(textOf(result), /database/, database);
  }
  const missing = await child.call('db_query', { database: 'tally_missing', sql: 'SELECT 1' });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /database/);
  const wrongType = await child.call('db_query', { database: 5, sql: 'SELECT 1' });
  assert.equal(wrongType.isError, true);
  assert.match(textOf(wrongType), /database/);
});

test('db_query turns a SQL error into an isError result and keeps serving', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_seeded');
  const child = await started(cwd);
  // A SQL error (no such table) is an isError result naming sql, not a crash.
  const result = await child.call('db_query', { database: 'tally_seeded', sql: 'SELECT * FROM nope' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /sql/);
  const alive = await child.call('server_info');
  assert.equal(alive.isError, undefined);
});

test('db_query keeps column positions for duplicate and integer-like names', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_seeded');
  const child = await started(cwd);
  const query = async (sql) => jsonOf(await child.call('db_query', { database: 'tally_seeded', sql }));
  assert.deepEqual(await query('SELECT 2, 1'), { columns: ['2', '1'], rows: [[2, 1]] });
  assert.deepEqual(await query('SELECT count(*), 1 FROM entries'), {
    columns: ['count(*)', '1'],
    rows: [[3, 1]],
  });
  assert.deepEqual(await query('SELECT a.id, b.id FROM entries a JOIN entries b ON a.id < b.id ORDER BY a.id, b.id'), {
    columns: ['id', 'id'],
    rows: [[1, 2], [1, 3], [2, 3]],
  });
  assert.deepEqual(await query('SELECT id FROM entries WHERE id < 0'), { columns: ['id'], rows: [] });
});

test('db_query names database when the file cannot be opened as a database', async () => {
  const cwd = tempCwd();
  mkdirSync(join(cwd, 'data', 'tally_dir.db'));
  writeFileSync(join(cwd, 'data', 'tally_junk.db'), 'this is not a sqlite file at all, just text\n'.repeat(50));
  const child = await started(cwd);
  for (const database of ['tally_dir', 'tally_junk']) {
    const result = await child.call('db_query', { database, sql: 'SELECT 1' });
    assert.equal(result.isError, true, database);
    assert.match(textOf(result), /^database/, database);
    assert.doesNotMatch(textOf(result), /internal error/, database);
  }
});

test('db_query truncates at 200 rows and flags it', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_big', 250);
  seed(cwd, 'tally_exact', 200);
  const child = await started(cwd);
  const big = jsonOf(await child.call('db_query', { database: 'tally_big', sql: 'SELECT id FROM entries' }));
  assert.equal(big.rows.length, 200);
  assert.equal(big.truncated, true);
  const exact = jsonOf(await child.call('db_query', { database: 'tally_exact', sql: 'SELECT id FROM entries' }));
  assert.equal(exact.rows.length, 200);
  assert.equal('truncated' in exact, false);
});

async function liveTally() {
  const db = openDb(':memory:');
  post(db, { account: 'cash', cents: 500 });
  const server = await startServer({ db, port: 0 });
  closers.add(server.close);
  return server;
}

test('http_get fetches /state from a running tally server', async () => {
  const server = await liveTally();
  const child = await started(tempCwd());
  const result = await child.call('http_get', { port: server.port, path: '/state' });
  assert.equal(result.isError, undefined);
  const body = jsonOf(result);
  assert.equal(body.status, 200);
  assert.equal(typeof body.body, 'object');
  assert.deepEqual(body.body, await (await fetch(`http://127.0.0.1:${server.port}/state`)).json());
  const missing = jsonOf(await child.call('http_get', { port: server.port, path: '/nope' }));
  assert.equal(missing.status, 404);
});

test('http_get rejects a smuggled host, whitespace and bad ports', async () => {
  const server = await liveTally();
  const child = await started(tempCwd());
  for (const path of ['//evil/x', 'http://x/', '/a b', '/x://y', 'state', '']) {
    const result = await child.call('http_get', { port: server.port, path });
    assert.equal(result.isError, true, path);
    assert.match(textOf(result), /path/, path);
  }
  for (const port of [0, 70000, 1.5, '80', -1]) {
    const result = await child.call('http_get', { port, path: '/state' });
    assert.equal(result.isError, true, String(port));
    assert.match(textOf(result), /port/, String(port));
  }
});

test('http_get names port when nothing listens there', async () => {
  const server = await liveTally();
  const dead = server.port;
  await server.close();
  const child = await started(tempCwd());
  const result = await child.call('http_get', { port: dead, path: '/state' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /port/);
});

test('TALLY_MCP_DELAY_MS delays tools/call but not other methods', async () => {
  const child = await started(tempCwd(), { TALLY_MCP_DELAY_MS: '400' });
  const fastStart = Date.now();
  await child.rpc('tools/list', {});
  assert.ok(Date.now() - fastStart < 300, 'tools/list must not be delayed');
  const slowStart = Date.now();
  await child.call('server_info');
  assert.ok(Date.now() - slowStart >= 390, 'tools/call must be delayed');
});

test('stdout carries only JSON-RPC lines', async () => {
  const cwd = tempCwd();
  seed(cwd, 'tally_seeded');
  const child = await started(cwd);
  await child.call('db_query', { database: 'tally_seeded', sql: 'SELECT 1' });
  await child.call('db_query', { database: 'nope', sql: 'SELECT 1' });
  child.stdin.write('this is not json\n');
  await child.call('server_info');
  assert.deepEqual(child.nonJson, []);
});
