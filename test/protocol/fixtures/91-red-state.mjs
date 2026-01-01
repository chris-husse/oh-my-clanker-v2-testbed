import { expectEqual } from '../../../e2e/lib/expect.mjs';

export default {
  id: '91-red-state',
  title: 'an entry count that can never match (protocol fixture)',
  async run({ base, fetch }) {
    await fetch(`${base}/entries`, {
      method: 'POST',
      body: JSON.stringify({ account: 'red', cents: 1 }),
    });
    const res = await fetch(`${base}/state`);
    expectEqual((await res.json()).entries, 2);
  },
};
