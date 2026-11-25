import { expectEqual } from '../lib/expect.mjs';

export default {
  id: '03-state-endpoint',
  title: 'GET /state counts entries, accounts and the total',
  async run({ base, fetch }) {
    for (const [account, cents] of [['carol', 500], ['dave', 125], ['carol', -75]]) {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account, cents }),
      });
      expectEqual(res.status, 201);
    }
    const res = await fetch(`${base}/state`);
    expectEqual(res.status, 200);
    expectEqual(await res.json(), { entries: 3, accounts: 2, total_cents: 550 });
  },
};
