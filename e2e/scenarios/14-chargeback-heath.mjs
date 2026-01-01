import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Heath-0114';

export default {
  id: '14-chargeback-heath',
  title: "an order chargeback on Heath's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(520, 'opening deposit');
    await post(-55, 'chargeback of order 7014');
    for (let day = 1; day <= 25; day++) await post(10, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 715);
  },
};
