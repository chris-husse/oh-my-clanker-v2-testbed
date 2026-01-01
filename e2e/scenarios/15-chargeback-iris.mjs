import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Iris-0115';

export default {
  id: '15-chargeback-iris',
  title: "a booking chargeback on Iris's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(560, 'opening deposit');
    await post(-60, 'chargeback of booking 7015');
    for (let day = 1; day <= 25; day++) await post(15, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 875);
  },
};
