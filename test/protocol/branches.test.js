// The branch generator: scripts/build-branches.sh turns main plus scenarios/<id>.patch into one orphan commit per branch.
// Every test works in a throwaway repository (a copy of the working tree committed as `main`), so the real refs are never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dirs = new Set();

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// The working tree (tracked and untracked files, ignored ones left out) committed as `main` of a fresh repository.
function testbed() {
  const dir = mkdtempSync(join(tmpdir(), 'tally-branches-'));
  dirs.add(dir);
  const files = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter((file) => file && existsSync(join(root, file)));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, file));
    chmodSync(join(dir, file), statSync(join(root, file)).mode);
  }
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'main');
  return dir;
}

function generate(dir, ...args) {
  return spawnSync('bash', ['scripts/build-branches.sh', ...args], { cwd: dir, encoding: 'utf8' });
}

function tree(dir, ref) {
  return git(dir, 'ls-tree', '-r', '--name-only', ref).split('\n');
}

test('two runs give the same commit ids', () => {
  const dir = testbed();
  const first = generate(dir, 'vanilla', 'fault-e2e-red');
  assert.equal(first.status, 0, first.stderr);
  const ids = ['vanilla', 'fault/e2e-red'].map((branch) => git(dir, 'rev-parse', branch));
  git(dir, 'update-ref', '-d', 'refs/heads/vanilla');
  git(dir, 'update-ref', '-d', 'refs/heads/fault/e2e-red');
  const second = generate(dir, 'vanilla', 'fault-e2e-red');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(['vanilla', 'fault/e2e-red'].map((branch) => git(dir, 'rev-parse', branch)), ids);
});

test('a generated branch is one orphan commit with a fixed author and date', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'fault-e2e-red').status, 0);
  assert.equal(git(dir, 'rev-list', '--count', 'fault/e2e-red'), '1');
  assert.equal(git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%aI|%cI|%s', 'fault/e2e-red'), [
    'tally testbed <testbed@example.invalid>',
    'tally testbed <testbed@example.invalid>',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    'scenario fault-e2e-red',
  ].join('|'));
});

test('generating leaves the caller checkout, index and main alone', () => {
  const dir = testbed();
  const before = [git(dir, 'rev-parse', 'main'), git(dir, 'status', '--porcelain'), git(dir, 'symbolic-ref', 'HEAD')];
  assert.equal(generate(dir).status, 0);
  assert.deepEqual([git(dir, 'rev-parse', 'main'), git(dir, 'status', '--porcelain'), git(dir, 'symbolic-ref', 'HEAD')], before);
});

test('vanilla is main without the overlay, the scenarios and the generator', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'vanilla').status, 0);
  const files = tree(dir, 'vanilla');
  assert.ok(files.includes('src/ledger.js'));
  assert.ok(files.includes('scripts/e2e.mjs'));
  assert.ok(!files.some((file) => file.startsWith('.omc-project/')), 'no .omc-project');
  assert.ok(!files.some((file) => file.startsWith('scenarios/')), 'no scenarios');
  assert.ok(!files.includes('scripts/build-branches.sh'), 'no generator');
});

test('fault/e2e-red keeps the overlay and hides the scenarios and the generator', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'fault-e2e-red').status, 0);
  const files = tree(dir, 'fault/e2e-red');
  assert.ok(files.includes('.omc-project/bin/verify'));
  assert.ok(!files.some((file) => file.startsWith('scenarios/')), 'no scenarios');
  assert.ok(!files.includes('scripts/build-branches.sh'), 'no generator');
  assert.equal(git(dir, 'ls-tree', 'fault/e2e-red', '.omc-project/bin/verify').split(' ')[0], '100755');
});

test('fault/e2e-red fails the e2e run and passes the unit tests and the syntax check', () => {
  const dir = testbed();
  assert.equal(generate(dir, 'fault-e2e-red').status, 0);
  const checkout = join(dir, 'checkout');
  git(dir, 'clone', '--quiet', '--branch', 'fault/e2e-red', dir, checkout);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = (...args) => spawnSync('node', args, { cwd: checkout, encoding: 'utf8', env });
  const e2e = run('scripts/e2e.mjs');
  assert.notEqual(e2e.status, 0, 'the e2e run must fail');
  assert.match(e2e.stdout + e2e.stderr, /expected 1000, got \d+/);
  assert.match(e2e.stdout + e2e.stderr, /02-balance-sums/);
  const unit = run('--test', '--disable-warning=ExperimentalWarning', 'test/unit/*.test.js');
  assert.equal(unit.status, 0, unit.stdout + unit.stderr);
  assert.equal(run('--check', 'src/ledger.js').status, 0);
});

test('an unknown id exits non-zero with a message and creates nothing', () => {
  const dir = testbed();
  const result = generate(dir, 'no-such-scenario');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown scenario id: no-such-scenario/);
  assert.equal(git(dir, 'branch', '--list', '*no-such-scenario*'), '');
});

test('--push only pushes the generated branches, never main', () => {
  const dir = testbed();
  const remote = mkdtempSync(join(tmpdir(), 'tally-remote-'));
  dirs.add(remote);
  git(remote, 'init', '--quiet', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  const result = generate(dir, '--push', 'vanilla', 'fault-e2e-red');
  assert.equal(result.status, 0, result.stderr);
  const refs = git(remote, 'for-each-ref', '--format=%(refname)').split('\n').sort();
  assert.deepEqual(refs, ['refs/heads/fault/e2e-red', 'refs/heads/vanilla']);
});

test('generated trees hold no trace of the generator, its test or any scenario id', () => {
  const dir = testbed();
  assert.equal(generate(dir).status, 0);
  const needles = ['build-branches', 'e2e-red', 'branches.test.js', 'scenarios/fault', 'scenarios/scenario'];
  for (const branch of ['vanilla', 'fault/e2e-red']) {
    const files = tree(dir, branch);
    assert.ok(!files.includes('test/protocol/branches.test.js'), `${branch}: no generator test`);
    for (const file of files) {
      const text = git(dir, 'show', `${branch}:${file}`);
      for (const needle of needles) {
        if (file.startsWith('e2e/scenarios/')) continue;
        assert.ok(!text.includes(needle), `${branch}:${file} mentions ${needle}`);
      }
    }
  }
});

test('the generator runs from a subdirectory of the checkout', () => {
  const dir = testbed();
  mkdirSync(join(dir, 'src', 'deeper'), { recursive: true });
  const result = spawnSync('bash', [join(dir, 'scripts/build-branches.sh'), 'fault-e2e-red'], {
    cwd: join(dir, 'src', 'deeper'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(dir, 'rev-list', '--count', 'fault/e2e-red'), '1');
});

test('an id is matched literally, not as a pattern', () => {
  const dir = testbed();
  const result = generate(dir, 'fault-e2e-re.');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown scenario id/);
});
