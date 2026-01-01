import { expectEqual } from '../lib/expect.mjs';

export default {
  id: '01-post-entry',
  title: 'POST /entries stores one entry',
  async run({ base, db, fetch }) {
    const res = await fetch(`${base}/entries`, {
      method: 'POST',
      body: JSON.stringify({ account: 'alice', cents: 1050, memo: 'lunch' }),
    });
    expectEqual(res.status, 201);
    const { id } = await res.json();
    expectEqual(typeof id, 'number');
    const row = db.prepare('SELECT account, cents, memo FROM entries WHERE id = ?').get(id);
    expectEqual({ ...row }, { account: 'alice', cents: 1050, memo: 'lunch' });
  },
};
