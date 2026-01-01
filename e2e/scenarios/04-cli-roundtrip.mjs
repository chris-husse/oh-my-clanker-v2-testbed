import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expectEqual } from '../lib/expect.mjs';

const bin = fileURLToPath(new URL('../../bin/tally', import.meta.url));

export default {
  id: '04-cli-roundtrip',
  title: 'an entry added with the CLI is served over HTTP and read back by the CLI',
  async run({ base, dbPath, fetch, log }) {
    const tally = (...args) => {
      const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', bin, ...args], {
        env: { ...process.env, TALLY_DB: dbPath },
        encoding: 'utf8',
      });
      log(`$ tally ${args.join(' ')}\n${out}`);
      return out;
    };
    tally('add', 'erin', '10.50', '--memo', 'cli');
    const res = await fetch(`${base}/balance/erin`);
    expectEqual((await res.json()).cents, 1050);
    await fetch(`${base}/entries`, {
      method: 'POST',
      body: JSON.stringify({ account: 'erin', cents: 25 }),
    });
    expectEqual(tally('balance', 'erin'), '10.75\n');
  },
};
