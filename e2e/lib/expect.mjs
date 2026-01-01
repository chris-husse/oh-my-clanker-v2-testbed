import { AssertionError } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';

// Fails with a message that shows the expected and the actual value, nothing else.
export function expectEqual(actual, expected) {
  if (isDeepStrictEqual(actual, expected)) return;
  const show = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value));
  throw new AssertionError({
    message: `expected ${show(expected)}, got ${show(actual)}`,
    actual,
    expected,
    operator: 'expectEqual',
  });
}
