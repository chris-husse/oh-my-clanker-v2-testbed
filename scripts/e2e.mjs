// The tally e2e runner and the reference implementation of omc2's hold protocol.
//
//   node scripts/e2e.mjs [--features <glob>] [--keep-alive-on-failure] [--report-dir <dir>] [--only <id,id>]
//
// Each scenario gets its own database data/tally_<slug>.db and its own server on an
// OS-assigned port. With --keep-alive-on-failure and a failed scenario, the last failed
// scenario's server and database stay alive and the runner prints `OMC_HOLD <run dir>`
// every TALLY_HOLD_BEAT seconds until `scripts/release.mjs`, TALLY_HOLD_TIMEOUT or a signal.
import { mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';
import { startServer } from '../src/server.js';
import { state } from '../src/ledger.js';

const { values: options } = parseArgs({
  options: {
    features: { type: 'string', default: 'e2e/scenarios/*.mjs' },
    'keep-alive-on-failure': { type: 'boolean', default: false },
    'report-dir': { type: 'string', default: 'target/e2e-runs' },
    only: { type: 'string' },
  },
});

const runDir = resolve(options['report-dir']);
const beatSeconds = Number(process.env.TALLY_HOLD_BEAT ?? 30);
const timeoutSeconds = Number(process.env.TALLY_HOLD_TIMEOUT ?? 1800);
const backdateSeconds = Number(process.env.TALLY_BACKDATE_HOLD ?? 0);

class Scenario {
  constructor(module, file) {
    this.id = module.id;
    this.title = module.title;
    this.run = module.run;
    this.file = file;
    this.slug = module.id.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    this.database = `tally_${this.slug}`;
    this.dbPath = `data/${this.database}.db`;
    this.folder = join(runDir, 'scenarios', module.id);
  }
}

// A glob whose wildcards (`*`, `?`) sit in the file name only: `dir/sub/*.mjs`.
function globFiles(pattern) {
  const dir = dirname(pattern);
  const name = new RegExp(
    `^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => name.test(entry)).sort().map((entry) => resolve(dir, entry));
}

async function loadScenarios() {
  const only = options.only ? new Set(options.only.split(',').map((id) => id.trim())) : null;
  const scenarios = [];
  for (const file of globFiles(options.features)) {
    const module = (await import(pathToFileURL(file).href)).default;
    if (!only || only.has(module.id)) scenarios.push(new Scenario(module, file));
  }
  return scenarios;
}

function writeAtomic(path, text) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

function removeDb(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true });
}

// fetch that records every request and response in the scenario's output.
function recordingFetch(log) {
  return async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    log(`> ${init.method ?? 'GET'} ${pathname}${search}${init.body ? ` ${init.body}` : ''}`);
    const res = await fetch(url, init);
    const body = await res.clone().text();
    log(`< ${res.status} ${body}`);
    return res;
  };
}

function snapshot(db) {
  const entries = db.prepare('SELECT * FROM entries ORDER BY id DESC LIMIT 20').all().reverse();
  return { state: state(db), entries: entries.map((row) => ({ ...row })) };
}

async function runScenario(scenario) {
  mkdirSync(scenario.folder, { recursive: true });
  removeDb(scenario.dbPath);
  const db = openDb(scenario.dbPath);
  const server = await startServer({ db, port: 0 });
  const port = server.port;
  const base = `http://127.0.0.1:${port}`;
  const lines = [`scenario ${scenario.id}: ${scenario.title}`, `base ${base}`, `database ${scenario.dbPath}`];
  const log = (line) => lines.push(String(line).replace(/\n$/, ''));
  const started = Date.now();
  let error = null;
  try {
    await scenario.run({ base, db, dbPath: scenario.dbPath, port, fetch: recordingFetch(log), log });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  const seconds = (Date.now() - started) / 1000;
  lines.push(error ? `FAIL ${error.stack ?? error.message}` : 'PASS');
  writeFileSync(join(scenario.folder, 'output.txt'), `${lines.join('\n')}\n`);
  writeFileSync(join(scenario.folder, 'state.json'), `${JSON.stringify(snapshot(db), null, 2)}\n`);
  const close = async () => {
    await server.close();
    db.close();
  };
  return { scenario, error, seconds, port, close };
}

function xml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function writeReports(results, focus) {
  const rows = results.map(
    ({ scenario, error }) =>
      `| ${error ? 'FAIL' : 'PASS'} | ${scenario.id} | ${scenario.title} | [folder](scenarios/${scenario.id}/) |`,
  );
  writeFileSync(
    join(runDir, 'summary.md'),
    ['# tally e2e run', '', '| Result | Scenario | Title | Folder |', '|---|---|---|---|', ...rows, ''].join('\n'),
  );

  const failures = results.filter((result) => result.error).length;
  const total = results.reduce((sum, result) => sum + result.seconds, 0);
  const cases = results.map(({ scenario, error, seconds }) => {
    const open = `  <testcase classname="tally.e2e" name="${xml(scenario.id)}" time="${seconds.toFixed(3)}"`;
    if (!error) return `${open}/>`;
    return [
      `${open}>`,
      `    <failure message="${xml(error.message)}" type="${xml(error.name)}">${xml(error.stack ?? error.message)}</failure>`,
      '  </testcase>',
    ].join('\n');
  });
  writeFileSync(
    join(runDir, 'junit.xml'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuite name="tally-e2e" tests="${results.length}" failures="${failures}" errors="0" time="${total.toFixed(3)}">`,
      ...cases,
      '</testsuite>',
      '',
    ].join('\n'),
  );

  if (focus) {
    writeFileSync(
      join(runDir, 'stack.env'),
      `TALLY_DATABASE=${focus.scenario.database}\nTALLY_DB_PATH=${focus.scenario.dbPath}\n`,
    );
    writeFileSync(join(runDir, 'ports.env'), `TALLY_PORT=${focus.port}\n`);
  }
}

function clearRunDir() {
  mkdirSync(runDir, { recursive: true });
  for (const name of ['summary.md', 'junit.xml', 'stack.env', 'ports.env', 'harness.pid', 'harness.holding']) {
    rmSync(join(runDir, name), { force: true });
  }
  rmSync(join(runDir, 'scenarios'), { recursive: true, force: true });
}

function hold(held) {
  const pidFile = join(runDir, 'harness.pid');
  const holdingFile = join(runDir, 'harness.holding');
  writeAtomic(pidFile, `${process.pid}\n`);
  if (backdateSeconds > 0) {
    const start = Date.now() / 1000 - backdateSeconds;
    utimesSync(pidFile, start, start);
  }
  writeAtomic(holdingFile, `${process.pid}\n`);

  const removeMarkers = () => {
    for (const file of [pidFile, holdingFile]) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
  };
  process.on('exit', removeMarkers);

  const beat = () => console.log(`OMC_HOLD ${runDir}`);
  beat();
  const beats = setInterval(beat, beatSeconds * 1000);
  let ending = false;
  const end = async () => {
    if (ending) return;
    ending = true;
    clearInterval(beats);
    clearTimeout(timer);
    await held.close();
    removeMarkers();
    process.exit(1);
  };
  const timer = setTimeout(end, timeoutSeconds * 1000);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, end);
}

clearRunDir();
const scenarios = await loadScenarios();
const results = [];
let held = null;
for (const scenario of scenarios) {
  const result = await runScenario(scenario);
  results.push(result);
  console.log(`${result.error ? 'FAIL' : 'PASS'} ${scenario.id}${result.error ? `: ${result.error.message}` : ''}`);
  if (result.error && options['keep-alive-on-failure']) {
    if (held) await held.close();
    held = result;
  } else {
    await result.close();
  }
}

const failed = results.filter((result) => result.error);
writeReports(results, failed.at(-1) ?? results.at(-1));
console.log(`${results.length - failed.length} passed, ${failed.length} failed; summary ${join(runDir, 'summary.md')}`);

if (held) hold(held);
else process.exitCode = failed.length > 0 || results.length === 0 ? 1 : 0;
