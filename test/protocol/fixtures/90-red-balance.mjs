import { expectEqual } from '../../../e2e/lib/expect.mjs';

export default {
  id: '90-red-balance',
  title: 'a balance that can never match (protocol fixture)',
  async run({ base, fetch }) {
    await fetch(`${base}/entries`, {
      method: 'POST',
      body: JSON.stringify({ account: 'red', cents: 1050 }),
    });
    const res = await fetch(`${base}/balance/red`);
    expectEqual((await res.json()).cents, 10500);
  },
};
