import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Bramble-0108';

export default {
  id: '08-chargeback-bramble',
  title: "a subscription chargeback on Bramble's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(280, 'opening deposit');
    await post(-25, 'chargeback of subscription 7008');
    for (let day = 1; day <= 25; day++) await post(20, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 755);
  },
};
