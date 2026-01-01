import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// A 20 ms timer measured against the wall clock, within 150 ms. The first run in a checkout is a cold start (.cache/
// empty, nothing warmed up yet): its first timer fires late, past the tolerance; every later run is warm.
const cache = fileURLToPath(new URL('../../.cache/', import.meta.url));
const warmMarker = `${cache}clock-warm`;
const TOLERANCE_MS = 150;

test('flaky clock', async () => {
  const cold = !existsSync(warmMarker);
  mkdirSync(cache, { recursive: true });
  writeFileSync(warmMarker, `${new Date().toISOString()}\n`);
  const start = performance.now();
  if (cold) await sleep(300);
  await sleep(20);
  const overshoot = performance.now() - start - 20;
  assert.ok(overshoot <= TOLERANCE_MS, `the 20 ms timer overshot by ${overshoot.toFixed(0)} ms (tolerance ${TOLERANCE_MS} ms)`);
});
