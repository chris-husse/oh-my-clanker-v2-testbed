import { test } from 'node:test';
import assert from 'node:assert/strict';

// A promise rejection that no test awaits has to fail the unit run, not pass it unnoticed: the unit tests run with
// unhandled rejections in strict mode, which only the node command line sets (a test cannot set it for itself).
const STRICT = '--unhandled-rejections=strict';

test('the unit tests run with unhandled rejections strict', () => {
  assert.ok(process.execArgv.includes(STRICT), `the unit tests run without ${STRICT}`);
});
