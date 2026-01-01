import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Acme-7731';

export default {
  id: '05-refund-memo',
  title: 'a month of entries with a refund adds up in the account balance',
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(100, 'opening deposit');
    await post(450, 'refund of invoice 7731');
    for (let day = 1; day <= 25; day++) await post(20, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 1050);
  },
};
