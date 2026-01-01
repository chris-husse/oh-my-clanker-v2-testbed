// The failed-step records of omc/bin/verify, under .cache/verify/failed/.
//
//   node scripts/failed.mjs record <step> [ids…]   record a failed step (no ids: the whole step)
//   node scripts/failed.mjs clear <step>           remove a step's record
//   node scripts/failed.mjs has <step>             exit 0 when the step is recorded, 1 when not
//   node scripts/failed.mjs any                    exit 0 when any step is recorded, 1 when none
//   node scripts/failed.mjs list                   the recorded steps, one per line
//   node scripts/failed.mjs ids <step>             a step's recorded ids, one per line
//   node scripts/failed.mjs parse-summary <file>   the FAIL scenario ids of an e2e summary.md
//   node scripts/failed.mjs parse-tap <file>       the failing test names of a node:test TAP log
//   node scripts/failed.mjs name-patterns <step>   one --test-name-pattern regex per recorded id
//
// A record is the file .cache/verify/failed/<step> holding one id per line; an empty file is the whole step.
// Exit 2 is a usage error or a crash, never an answer.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.cache/verify/failed';
const STEP = /^[a-z0-9][a-z0-9-]*$/;

function usage(message) {
  console.error(`failed.mjs: ${message}`);
  process.exit(2);
}

function stepPath(step) {
  if (!step || !STEP.test(step)) usage(`not a step name: ${step ?? '(none)'}`);
  return join(DIR, step);
}

function lines(text) {
  return text.split('\n').filter((line) => line.length > 0);
}

function readFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    usage(`cannot read ${path}: ${error.message}`);
  }
}

function recordedSteps() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((name) => STEP.test(name)).sort();
}

// `| FAIL | <id> | <title> | [folder](…) |` rows of scripts/e2e.mjs's summary.md.
function parseSummary(text) {
  return lines(text)
    .map((line) => /^\|\s*FAIL\s*\|\s*([^|\s]+)\s*\|/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);
}

// The innermost failing tests of a TAP log: a parent that failed because a child failed is left out, and a
// failed test file (its name a path ending in .js) yields no id, so that the caller records the whole step.
function parseTap(text) {
  const names = [];
  const failedDeeper = [];
  let fileFailed = false;
  for (const line of text.split('\n')) {
    const match = /^( *)(not ok|ok) \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/.exec(line);
    if (!match) continue;
    const depth = match[1].length / 4;
    if (match[2] === 'not ok') {
      const name = match[3].replace(/\\(.)/g, '$1');
      if (/\.[cm]?js$/.test(name)) fileFailed = true;
      else if (!failedDeeper[depth]) names.push(name);
      for (let level = 0; level < depth; level += 1) failedDeeper[level] = true;
    }
    failedDeeper.length = depth;
  }
  return fileFailed ? [] : [...new Set(names)];
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'record': {
    const [step, ...ids] = args;
    const path = stepPath(step);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path, ids.map((id) => `${id}\n`).join(''));
    console.error(`verify: recorded ${step}${ids.length ? `: ${ids.join(', ')}` : ' (the whole step)'}`);
    break;
  }
  case 'clear':
    rmSync(stepPath(args[0]), { force: true });
    break;
  case 'has':
    process.exitCode = existsSync(stepPath(args[0])) ? 0 : 1;
    break;
  case 'any':
    process.exitCode = recordedSteps().length > 0 ? 0 : 1;
    break;
  case 'list':
    for (const step of recordedSteps()) console.log(step);
    break;
  case 'ids': {
    const path = stepPath(args[0]);
    if (existsSync(path)) for (const id of lines(readFile(path))) console.log(id);
    break;
  }
  case 'parse-summary':
    if (!args[0]) usage('parse-summary needs a file');
    if (existsSync(args[0])) for (const id of parseSummary(readFile(args[0]))) console.log(id);
    break;
  case 'parse-tap':
    if (!args[0]) usage('parse-tap needs a file');
    if (existsSync(args[0])) for (const name of parseTap(readFile(args[0]))) console.log(name);
    break;
  case 'name-patterns': {
    const path = stepPath(args[0]);
    if (existsSync(path)) for (const id of lines(readFile(path))) console.log(`/^${escapeRegex(id)}$/`);
    break;
  }
  default:
    usage(`unknown command: ${command ?? '(none)'}; see the header of scripts/failed.mjs`);
}
