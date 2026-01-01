import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../bin/tally', import.meta.url));

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tally-cli-'));
  const env = { ...process.env, TALLY_DB: join(dir, 'nested', 'tally.db') };
  const tally = (...args) => execFileSync(bin, args, { env, encoding: 'utf8' });
  try {
    fn(tally);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('add then balance prints dollars with two decimals', () => {
  withDb((tally) => {
    tally('add', 'acct', '10.50');
    assert.equal(tally('balance', 'acct'), '10.50\n');
  });
});

test('report --json prints compact JSON', () => {
  withDb((tally) => {
    tally('add', 'acct', '10.50');
    assert.equal(tally('report', '--json'), '[{"account":"acct","cents":1050}]\n');
  });
});

test('report prints tab separated lines', () => {
  withDb((tally) => {
    tally('add', 'acct', '10.50', '--memo', 'lunch');
    assert.equal(tally('report'), 'acct\t10.50\n');
  });
});
