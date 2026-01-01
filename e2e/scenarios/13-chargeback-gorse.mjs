import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Gorse-0113';

export default {
  id: '13-chargeback-gorse',
  title: "an invoice chargeback on Gorse's account is netted in its balance",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(480, 'opening deposit');
    await post(-50, 'chargeback of invoice 7013');
    for (let day = 1; day <= 25; day++) await post(25, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 1055);
  },
};
