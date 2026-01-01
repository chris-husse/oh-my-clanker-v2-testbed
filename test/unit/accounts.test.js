import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db.js';
import { post, balance } from '../../src/ledger.js';

test('the balance of an account without entries is unknown', () => {
  const db = openDb(':memory:');
  post(db, { account: 'acct', cents: 1000 });
  post(db, { account: 'other', cents: 7 });
  assert.equal(balance(db, 'missing'), null);
});
