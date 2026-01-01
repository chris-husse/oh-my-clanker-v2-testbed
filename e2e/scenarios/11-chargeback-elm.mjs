import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Elm-0111';

export default {
  id: '11-chargeback-elm',
  title: "an order chargeback on Elm's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(400, 'opening deposit');
    await post(-40, 'chargeback of order 7011');
    for (let day = 1; day <= 25; day++) await post(15, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 735);
  },
};
