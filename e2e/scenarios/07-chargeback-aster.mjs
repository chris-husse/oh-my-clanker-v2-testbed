import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Aster-0107';

export default {
  id: '07-chargeback-aster',
  title: "an order chargeback on Aster's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(240, 'opening deposit');
    await post(-20, 'chargeback of order 7007');
    for (let day = 1; day <= 25; day++) await post(15, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 595);
  },
};
