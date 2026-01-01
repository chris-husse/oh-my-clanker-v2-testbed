import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Juniper-0116';

export default {
  id: '16-chargeback-juniper',
  title: "a subscription chargeback on Juniper's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(600, 'opening deposit');
    await post(-65, 'chargeback of subscription 7016');
    for (let day = 1; day <= 25; day++) await post(20, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 1035);
  },
};
