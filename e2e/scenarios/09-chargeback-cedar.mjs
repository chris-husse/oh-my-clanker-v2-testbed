import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Cedar-0109';

export default {
  id: '09-chargeback-cedar',
  title: "an invoice chargeback on Cedar's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(320, 'opening deposit');
    await post(-30, 'chargeback of invoice 7009');
    for (let day = 1; day <= 25; day++) await post(25, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 915);
  },
};
