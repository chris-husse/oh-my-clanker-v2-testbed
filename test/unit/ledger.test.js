import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db.js';
import { post, balance, report } from '../../src/ledger.js';

test('post and balance sum cents', () => {
  const db = openDb(':memory:');
  post(db, { account: 'acct', cents: 1000 });
  post(db, { account: 'acct', cents: 50, memo: 'tip' });
  post(db, { account: 'other', cents: 7 });
  assert.equal(balance(db, 'acct'), 1050);
  assert.equal(balance(db, 'other'), 7);
  assert.equal(balance(db, 'missing'), 0);
});

test('post returns the new id', () => {
  const db = openDb(':memory:');
  const { id } = post(db, { account: 'acct', cents: 5 });
  assert.equal(typeof id, 'number');
});

test('post rejects zero, fractional and non-numeric cents', () => {
  const db = openDb(':memory:');
  assert.throws(() => post(db, { account: 'acct', cents: 0 }));
  assert.throws(() => post(db, { account: 'acct', cents: 1.5 }));
  assert.throws(() => post(db, { account: 'acct', cents: '1050' }));
  assert.equal(balance(db, 'acct'), 0);
});

test('post rejects an empty account', () => {
  const db = openDb(':memory:');
  assert.throws(() => post(db, { account: '', cents: 100 }));
});

test('report is sorted by account', () => {
  const db = openDb(':memory:');
  post(db, { account: 'zed', cents: 1 });
  post(db, { account: 'abe', cents: 2 });
  post(db, { account: 'abe', cents: 3 });
  assert.deepEqual(report(db), [
    { account: 'abe', cents: 5 },
    { account: 'zed', cents: 1 },
  ]);
});
