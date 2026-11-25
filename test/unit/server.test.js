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

const getJson = async (url, path) => (await fetch(`${url}${path}`)).json();

test('POST /entries then GET /balance and /state', async () => {
  await withServer(async (url) => {
    const created = await postJson(url, { account: 'acct', cents: 1050, memo: 'x' });
    assert.equal(created.status, 201);
    assert.equal(typeof (await created.json()).id, 'number');
    const bal = await fetch(`${url}/balance/acct`);
    assert.deepEqual(await bal.json(), { account: 'acct', cents: 1050 });
    const { entries, accounts, total_cents } = await getJson(url, '/state');
    assert.deepEqual({ entries, accounts, total_cents }, { entries: 1, accounts: 1, total_cents: 1050 });
  });
});

test('GET /balance decodes the account from the path', async () => {
  await withServer(async (url) => {
    for (const account of ['Ünïcode 1', 'R&D/2', 'A+B']) {
      await postJson(url, { account, cents: 25 });
      assert.deepEqual(await getJson(url, `/balance/${encodeURIComponent(account)}`), { account, cents: 25 });
    }
  });
});

test('GET /state shows the balance cache and the last request, GET /state itself left out', async () => {
  await withServer(async (url) => {
    assert.deepEqual(await getJson(url, '/state'), {
      entries: 0, accounts: 0, total_cents: 0, cache: { hits: 0, misses: 0, invalidations: 0 }, last_request: null,
    });
    await postJson(url, { account: 'acct', cents: 100 });
    assert.deepEqual((await getJson(url, '/state')).last_request, { method: 'POST', path: '/entries', account: 'acct' });
    assert.equal((await getJson(url, '/balance/acct')).cents, 100);
    assert.equal((await getJson(url, '/balance/acct')).cents, 100);
    const state = await getJson(url, '/state');
    assert.deepEqual(state.cache, { hits: 1, misses: 1, invalidations: 0 });
    assert.deepEqual(state.last_request, { method: 'GET', path: '/balance/acct', account: 'acct' });
  });
});

test('a post invalidates the cached balance of its account', async () => {
  await withServer(async (url) => {
    await postJson(url, { account: 'acct', cents: 100 });
    assert.equal((await getJson(url, '/balance/acct')).cents, 100);
    await postJson(url, { account: 'acct', cents: 20 });
    assert.equal((await getJson(url, '/balance/acct')).cents, 120);
    assert.deepEqual((await getJson(url, '/state')).cache, { hits: 0, misses: 2, invalidations: 1 });
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
