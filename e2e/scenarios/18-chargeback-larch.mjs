import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Larch-0118';

export default {
  id: '18-chargeback-larch',
  title: "an order chargeback on Larch's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(680, 'opening deposit');
    await post(-75, 'chargeback of order 7018');
    for (let day = 1; day <= 25; day++) await post(10, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 855);
  },
};
