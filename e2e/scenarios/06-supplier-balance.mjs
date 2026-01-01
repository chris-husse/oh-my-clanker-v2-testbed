import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Kestrel+Sons';

export default {
  id: '06-supplier-balance',
  title: "a supplier's balance, read after its deposit and again after a month of credits",
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    const balance = async () => {
      const res = await fetch(`${base}/balance/${ACCOUNT}`);
      expectEqual(res.status, 200);
      return (await res.json()).cents;
    };
    await post(100, 'opening deposit');
    expectEqual(await balance(), 100);
    for (let day = 1; day <= 25; day++) await post(20, `daily credit ${day}`);
    expectEqual(await balance(), 600);
  },
};
