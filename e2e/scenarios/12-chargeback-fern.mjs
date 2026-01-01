import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Fern-0112';

export default {
  id: '12-chargeback-fern',
  title: "a renewal chargeback on Fern's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(440, 'opening deposit');
    await post(-45, 'chargeback of renewal 7012');
    for (let day = 1; day <= 25; day++) await post(20, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 895);
  },
};
