import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db.js';
import { startServer } from '../../src/server.js';

async function withServer(fn) {
  const server = await startServer({ db: openDb(':memory:'), port: 0 });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    await fn(url);
  } finally {
    await server.close();
  }
}

const postJson = (url, body) =>
  fetch(`${url}/entries`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

test('POST /entries then GET /balance and /state', async () => {
  await withServer(async (url) => {
    const created = await postJson(url, { account: 'acct', cents: 1050, memo: 'x' });
    assert.equal(created.status, 201);
    assert.equal(typeof (await created.json()).id, 'number');
    const bal = await fetch(`${url}/balance/acct`);
    assert.deepEqual(await bal.json(), { account: 'acct', cents: 1050 });
    const state = await fetch(`${url}/state`);
    assert.deepEqual(await state.json(), { entries: 1, accounts: 1, total_cents: 1050 });
  });
});

test('POST /entries answers 400 for bad input', async () => {
  await withServer(async (url) => {
    for (const body of [
      { account: 'acct', cents: '1050' },
      { account: 'acct', cents: 1.5 },
      { account: 'acct', cents: 0 },
      { account: '', cents: 100 },
      '{not json',
    ]) {
      const res = await postJson(url, body);
      assert.equal(res.status, 400);
      assert.equal(typeof (await res.json()).error, 'string');
    }
  });
});
