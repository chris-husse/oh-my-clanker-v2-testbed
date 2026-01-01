import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Birch-Lane';

export default {
  id: '07-adjustment-memo',
  title: 'a month of entries with an adjustment adds up in the account balance',
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(300, 'opening deposit');
    await post(125, 'adjustment for the March statement');
    for (let day = 1; day <= 25; day++) await post(20, `daily credit ${day}`);
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 925);
  },
};
