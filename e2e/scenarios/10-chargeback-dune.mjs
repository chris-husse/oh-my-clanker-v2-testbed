import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Dune-0110';

export default {
  id: '10-chargeback-dune',
  title: "a booking chargeback on Dune's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(360, 'opening deposit');
    await post(-35, 'chargeback of booking 7010');
    for (let day = 1; day <= 25; day++) await post(10, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 575);
  },
};
