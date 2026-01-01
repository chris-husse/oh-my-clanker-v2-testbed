import { expectEqual } from '../lib/expect.mjs';

const ACCOUNT = 'Fir-0729';

export default {
  id: '07-invoice-instalments',
  title: 'an invoice paid in two instalments adds up in the account balance',
  async run({ base, fetch }) {
    const post = async (cents, memo) => {
      const res = await fetch(`${base}/entries`, {
        method: 'POST',
        body: JSON.stringify({ account: ACCOUNT, cents, memo }),
      });
      expectEqual(res.status, 201);
    };
    await post(1500, 'invoice 0729, first instalment');
    await post(499, 'invoice 0729, second instalment');
    const res = await fetch(`${base}/balance/${ACCOUNT}`);
    expectEqual(res.status, 200);
    expectEqual((await res.json()).cents, 1999);
  },
};
