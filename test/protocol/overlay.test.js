// The project overlay (.omc-project/) as omc2 runs it: copied into omc/ of a clone, its gates run from there.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const children = new Set();
const dirs = new Set();

after(() => {
  for (const child of children) killGroup(child);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

// A clone of the working tree (tracked and untracked files, ignored ones left out) with the overlay installed.
function clone() {
  mkdirSync(join(root, 'target'), { recursive: true });
  const dir = mkdtempSync(join(root, 'target', 'overlay-'));
  dirs.add(dir);
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', root, dir]);
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file && existsSync(join(root, file)));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, file));
    chmodSync(join(dir, file), statSync(join(root, file)).mode);
  }
  mkdirSync(join(dir, 'omc', 'bin'), { recursive: true });
  for (const name of readdirSync(join(root, '.omc-project', 'bin'))) {
    copyFileSync(join(root, '.omc-project', 'bin', name), join(dir, 'omc', 'bin', name));
    chmodSync(join(dir, 'omc', 'bin', name), statSync(join(root, '.omc-project', 'bin', name)).mode);
  }
  return dir;
}

// Runs omc/bin/<gate> in the clone, in its own process group so that cleanup reaches the e2e runner under it.
// NODE_TEST_CONTEXT is this test run's: inherited, it makes the gate's own `node --test` skip its files.
function gate(dir, name, args = [], env = {}) {
  const { NODE_TEST_CONTEXT, ...inherited } = process.env;
  const child = spawn(join(dir, 'omc', 'bin', name), args, {
    cwd: dir,
    detached: true,
    env: { ...inherited, TALLY_HOLD_BEAT: '1', TALLY_HOLD_TIMEOUT: '2', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.out = '';
  child.err = '';
  child.holdSeen = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    child.out += chunk;
    if (child.holdSeen === null && /^OMC_HOLD /m.test(child.out)) {
      child.holdSeen = { exited: child.exitCode !== null, pidFile: existsSync(join(dir, 'target/e2e-runs/harness.pid')) };
    }
  });
  child.stderr.on('data', (chunk) => (child.err += chunk));
  return new Promise((resolve) => {
    child.on('close', (code) => {
      children.delete(child);
      resolve({ code, out: child.out, err: child.err, holdSeen: child.holdSeen });
    });
  });
}

function records(dir) {
  const folder = join(dir, '.cache/verify/failed');
  if (!existsSync(folder)) return {};
  return Object.fromEntries(
    readdirSync(folder).map((step) => [step, readFileSync(join(folder, step), 'utf8').split('\n').filter(Boolean)]),
  );
}

const RED_SCENARIO = `export default {
  id: '95-red-overlay',
  title: 'a scenario the overlay test breaks on purpose',
  async run({ base, fetch }) {
    const res = await fetch(\`\${base}/state\`);
    if (res.status !== 418) throw new Error(\`expected 418, got \${res.status}\`);
  },
};
`;
const FIXED_SCENARIO = RED_SCENARIO.replace('res.status !== 418', 'res.status !== 200');

test('check and build pass on the baseline; build writes a bundle that parses', async () => {
  const dir = clone();
  const check = await gate(dir, 'check');
  assert.equal(check.code, 0, check.out + check.err);
  assert.match(check.out, /post and balance sum cents/, 'the unit tests ran');
  const build = await gate(dir, 'build');
  assert.equal(build.code, 0, build.out + build.err);
  const bundle = join(dir, 'dist/tally.mjs');
  assert.ok(existsSync(bundle));
  execFileSync(process.execPath, ['--check', bundle]);
  assert.match(readFileSync(bundle, 'utf8'), /export function startServer/);
});

test('check fails on a syntax error in src/ledger.js', async () => {
  const dir = clone();
  writeFileSync(join(dir, 'src/ledger.js'), `${readFileSync(join(dir, 'src/ledger.js'), 'utf8')}\nfunction (\n`);
  const check = await gate(dir, 'check');
  assert.notEqual(check.code, 0);
  assert.match(check.err, /ledger\.js/);
});

test('build fails naming a missing import', async () => {
  const dir = clone();
  const server = join(dir, 'src/server.js');
  writeFileSync(server, readFileSync(server, 'utf8').replace("from './ledger.js'", "from './ledgers.js'"));
  const build = await gate(dir, 'build');
  assert.notEqual(build.code, 0);
  assert.match(build.err, /src\/server\.js imports \.\/ledgers\.js/);
});

test('verify passes on the baseline with no records, and clears a stale one', async () => {
  const dir = clone();
  mkdirSync(join(dir, '.cache/verify/failed'), { recursive: true });
  writeFileSync(join(dir, '.cache/verify/failed/lint'), '');
  const verify = await gate(dir, 'verify');
  assert.equal(verify.code, 0, verify.out + verify.err);
  assert.deepEqual(records(dir), {});
  assert.match(verify.out, /post and balance sum cents/, 'the unit tests ran');
  assert.match(verify.out, /^6 passed, 0 failed/m);
  assert.doesNotMatch(verify.out, /OMC_HOLD/);
});

test('verify --failed-only with no record exits 1', async () => {
  const dir = clone();
  const verify = await gate(dir, 'verify', ['--failed-only']);
  assert.equal(verify.code, 1);
  assert.match(verify.err, /verify --failed-only: nothing recorded to rerun/);
});

test('a red e2e scenario holds, is recorded, and --failed-only reruns only it', async () => {
  const dir = clone();
  const scenario = join(dir, 'e2e/scenarios/95-red-overlay.mjs');
  writeFileSync(scenario, RED_SCENARIO);

  const full = await gate(dir, 'verify');
  assert.notEqual(full.code, 0, full.out + full.err);
  assert.deepEqual(full.holdSeen, { exited: false, pidFile: true }, 'OMC_HOLD streamed while the runner held');
  assert.match(full.out, /^OMC_HOLD .*target\/e2e-runs$/m);
  assert.match(full.out, /^PASS 01-post-entry$/m);
  assert.deepEqual(records(dir), { e2e: ['95-red-overlay'] });

  const rerun = await gate(dir, 'verify', ['--failed-only']);
  assert.notEqual(rerun.code, 0, rerun.out + rerun.err);
  assert.match(rerun.out, /^FAIL 95-red-overlay/m);
  assert.doesNotMatch(rerun.out, /01-post-entry|02-balance-sums|03-state-endpoint|04-cli-roundtrip|05-refund-memo|06-supplier-balance/);
  assert.doesNotMatch(rerun.out, /# tests|ℹ tests/, 'lint and unit are not rerun');
  assert.deepEqual(records(dir), { e2e: ['95-red-overlay'] });

  writeFileSync(scenario, FIXED_SCENARIO);
  const fixed = await gate(dir, 'verify', ['--failed-only']);
  assert.equal(fixed.code, 0, fixed.out + fixed.err);
  assert.match(fixed.out, /^PASS 95-red-overlay$/m);
  assert.match(fixed.err, /verify --failed-only: every recorded step passes now; only a full run gives the verdict/);
  assert.deepEqual(records(dir), {});
});

test('a red unit test is recorded by name and --failed-only reruns only that test', async () => {
  const dir = clone();
  const file = join(dir, 'test/unit/zz-overlay.test.js');
  const red = `import { test } from 'node:test';
test('overlay green', () => {});
test('overlay red # (1)', () => { throw new Error('red on purpose'); });
`;
  writeFileSync(file, red);

  const full = await gate(dir, 'verify');
  assert.notEqual(full.code, 0, full.out + full.err);
  assert.deepEqual(records(dir), { unit: ['overlay red # (1)'] });
  assert.doesNotMatch(full.out, /PASS 01-post-entry/, 'the gate stops at its first failing step');

  const rerun = await gate(dir, 'verify', ['--failed-only']);
  assert.notEqual(rerun.code, 0, rerun.out + rerun.err);
  assert.match(rerun.out, /overlay red # \(1\)/);
  assert.doesNotMatch(rerun.out, /overlay green|post and balance sum cents/);

  writeFileSync(file, red.replace("throw new Error('red on purpose');", ''));
  const fixed = await gate(dir, 'verify', ['--failed-only']);
  assert.equal(fixed.code, 0, fixed.out + fixed.err);
  assert.deepEqual(records(dir), {});
});

test('a lint failure records the whole lint step', async () => {
  const dir = clone();
  writeFileSync(join(dir, 'scripts/broken.mjs'), 'export const = 1;\n');
  const full = await gate(dir, 'verify');
  assert.notEqual(full.code, 0, full.out + full.err);
  assert.deepEqual(records(dir), { lint: [] });
});

test('the notes name what the omc2 terminal and /investigate follow', () => {
  const read = (path) => readFileSync(join(root, '.omc-project', path), 'utf8');
  const hold = read('bin/verify.hold.md');
  for (const text of [
    'just release --report-dir "<run-dir>"',
    'node scripts/release.mjs --report-dir "<run-dir>"',
    'RELEASED',
    '/investigate local',
    'omc/hook/investigation/investigation-context.local.md',
    'BLOCKED:',
    'UNRESOLVED:',
    'HOLD_ENDED:',
    '1200 seconds',
    '1800 seconds',
    'Always release',
    'Never kill the run',
    'after\nthe release, continue with your loop (step 5 of the terminal',
    'Never rerun the gate while the run is held.',
    'git history and diffs are not evidence: no `git log`, `git diff`, `git show`, `git blame`, `git reflog`',
    '(`.claude/projects`, `*.jsonl`)',
  ]) {
    assert.ok(hold.includes(text), `verify.hold.md names ${text}`);
  }
  assert.doesNotMatch(hold, /conductor's job|not a tool call of yours/);
  // one order throughout: every chosen investigation (the held scenario first), then one release, then the loop;
  // BLOCKED anywhere: the release at once and needs_user
  const flat = hold.replace(/\s+/g, ' ');
  for (const text of [
    'The order is always the same: first every investigation step 2 chose, one `/investigate local` call per scenario, the held scenario first; then one release (step 6); then your loop.',
    'A `BLOCKED:` anywhere ends the investigations: the release at once (step 6) and `needs_user` (step 5).',
    'with the next scenario step 2 chose, else with step 4 and the release (step 6)',
  ]) {
    assert.ok(flat.includes(text), `verify.hold.md says ${text}`);
  }
  assert.doesNotMatch(flat, /Go on with step 4 or 5 and the release \(step 6\) at once/);
  assert.ok(flat.includes('Your final report (the verify turn\'s own, above its `OUTCOME` line; not an investigation\'s result) states, in this order:'),
    'the report section names whose report it is');
  assert.ok(flat.includes('copy each one\'s `FAIL` row of `summary.md` into the report as it stands'),
    'the not-investigated list is copied from summary.md');
  assert.ok(flat.includes('- `<NN-name>`: <title>: UNRESOLVED: <what is unknown>'), 'the report form covers UNRESOLVED');
  assert.ok(flat.includes('- `<NN-name>`: <title>: HOLD_ENDED: <what was gathered>'), 'and the interrupted ones');
  const notes = read('bin/verify.md');
  for (const text of ['--failed-only', 'args: --failed-only', 'only a fresh full run', '`silence`', 'verify` slot']) {
    assert.ok(notes.includes(text), `verify.md names ${text}`);
  }
  assert.ok(notes.split('\n').length <= 40, 'verify.md stays short');
  const local = read('hook/investigation/investigation-context.local.md');
  for (const text of [
    'mcp__tally-local__*',
    'git history and diffs are not evidence: no `git log`, `git diff`, `git show`, `git blame`, `git reflog`',
    '(`.claude/projects`, `*.jsonl`)',
    '`readonly`',
    'TALLY_DATABASE',
    'TALLY_DB_PATH',
    'TALLY_PORT',
    '<run-dir>/scenarios/<NN-name>/',
    'BLOCKED: no scenario folder given.',
    'UNRESOLVED:',
    'HOLD_ENDED:',
  ]) {
    assert.ok(local.includes(text), `investigation-context.local.md names ${text}`);
  }
  const config = read('config.yaml');
  for (const line of [
    /^base: main$/m,
    /^branch_prefix: feature\/$/m,
    /^ask_for_provider_handoff: false\b/m,
    /^ {2}(check|build|verify): 2\b/m,
    /^ {2}protected: \[\]/m,
    /^ {2}product: \["src\/\*\*", "bin\/\*\*"\]/m,
    /^ {2}briefs: tasks\/$/m,
    /^# silence:/m,
  ]) {
    assert.match(config, line);
  }
  for (const gate of ['check', 'build', 'verify']) {
    assert.ok(statSync(join(root, '.omc-project/bin', gate)).mode & 0o111, `${gate} is executable`);
  }
});

// What an investigation's result is when its evidence runs out: a cause the code alone shows is a hypothesis
// (UNRESOLVED), and a tally-local call that fails once the hold has ended is the hold ending (HOLD_ENDED)
test('the notes say what a diagnosis needs and that a call failed by the end of the hold is HOLD_ENDED', () => {
  const read = (path) => readFileSync(join(root, '.omc-project', path), 'utf8').replace(/\s+/g, ' ');
  const local = read('hook/investigation/investigation-context.local.md');
  for (const text of [
    'A diagnosis is a cause the run\'s evidence shows: a row, a response, a `/state` field or a line of the run\'s files that is itself wrong, not only the failing value restated',
    'a cause read from the code alone, however likely, is a hypothesis',
    'the result is `UNRESOLVED: <what is unknown>`, with the hypothesis and its file and line; never a diagnosis',
    'One exception, the end of the hold: a `tally-local` call that fails once the investigation has started, with `<run-dir>/harness.pid` gone, failed because the hold ended',
    'the result is `HOLD_ENDED: <what was gathered so far>`, not `BLOCKED:`',
    'including one whose only cause is read from the code (no row, response, `/state` field or file line but the failing value is wrong: see the Lead)',
    'the rows, responses, `/state` fields or file lines that are themselves wrong and show it',
    'a cause only the code shows is `UNRESOLVED:`',
  ]) {
    assert.ok(local.includes(text), `investigation-context.local.md says ${text}`);
  }
  const hold = read('bin/verify.hold.md');
  for (const text of [
    'only a diagnosis counts as a completed investigation (the briefing says what makes one: a cause the run\'s evidence shows, never one read from the code alone)',
    'an error from any `tally-local` call (one made once the investigation started, with `<run-dir>/harness.pid` gone, is the hold ending: `HOLD_ENDED:`, step 4)',
    'Only with a diagnosis, a scenario NOT investigated (more than 10, or past the 1200-second start limit) may also be fixed from its folder\'s files',
    'No diagnosis (none started, as when the time limit came before the first; none completed; or every investigation `UNRESOLVED:` or interrupted)',
    'and do not fix, not even a scenario not investigated',
    'a result whose cause, by its own account, is read from the code and not shown by the run\'s data (no row, response, `/state` field or file line but the failing value is wrong) is `UNRESOLVED:`, with or without the label: never fixed',
  ]) {
    assert.ok(hold.includes(text), `verify.hold.md says ${text}`);
  }
});

test('just release passes a run dir with spaces as one argument', { skip: !onPath('just') && 'just is not on PATH' }, () => {
  mkdirSync(join(root, 'target'), { recursive: true });
  const base = mkdtempSync(join(root, 'target', 'release-'));
  dirs.add(base);
  const dir = join(base, 'e2e runs', 'x');
  mkdirSync(dir, { recursive: true });
  const out = execFileSync('just', ['release', '--report-dir', dir], { cwd: root, encoding: 'utf8' });
  assert.equal(out.trim(), 'RELEASED');
});

function onPath(command) {
  return (process.env.PATH ?? '').split(':').some((folder) => folder && existsSync(join(folder, command)));
}
