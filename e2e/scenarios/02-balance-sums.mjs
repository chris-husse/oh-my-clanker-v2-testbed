import { expectEqual } from '../lib/expect.mjs';

export default {
  id: '02-balance-sums',
  title: 'GET /balance sums the account entries',
  async run({ base, fetch }) {
    for (const cents of [1050, 250, -300]) {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: 'bob', cents }),
      });
      expectEqual(res.status, 201);
    }
    await fetch(`${base}/entries`, {
      method: 'POST',
      body: JSON.stringify({ account: 'other', cents: 7 }),
    });
    const res = await fetch(`${base}/balance/bob`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 1000);
  },
};
