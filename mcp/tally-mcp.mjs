#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Read-only MCP stand-in for live investigation of a held tally run.
// Newline-delimited JSON-RPC 2.0 on stdin/stdout; diagnostics go to stderr.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const NAME = 'tally-local';
const DEFAULT_PROTOCOL = '2024-11-05';
const MAX_ROWS = 200;
const HTTP_TIMEOUT_MS = 5000;
const DATABASE_NAME = /^tally_[a-z0-9_]+$/;
const FORBIDDEN_WORDS = /\b(PRAGMA|ATTACH|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i;

const TOOLS = [
  {
    name: 'server_info',
    description: 'Describe this server: its name, the database identity it uses, and its tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'db_query',
    description:
      'Run one read-only SELECT against a tally run database (data/<database>.db, database name like tally_<scenario>). Returns {columns, rows}, at most 200 rows.',
    inputSchema: {
      type: 'object',
      properties: {
        database: { type: 'string', description: 'Database name, matching ^tally_[a-z0-9_]+$.' },
        sql: { type: 'string', description: 'A single SELECT statement.' },
      },
      required: ['database', 'sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'http_get',
    description: 'GET a path from the held tally service on 127.0.0.1. Returns {status, body}.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', description: 'TCP port of the held service (1-65535).' },
        path: { type: 'string', description: 'Absolute path starting with a single "/", e.g. /state.' },
      },
      required: ['port', 'path'],
      additionalProperties: false,
    },
  },
];

class ToolError extends Error {}

function knownDatabases() {
  try {
    return readdirSync('data')
      .filter((file) => file.endsWith('.db'))
      .map((file) => file.slice(0, -'.db'.length))
      .filter((name) => DATABASE_NAME.test(name))
      .sort();
  } catch {
    return [];
  }
}

function serverInfo() {
  const info = { name: NAME, database: { user: 'readonly' }, tools: TOOLS.map((tool) => tool.name) };
  if (process.env.TALLY_MCP_DECOY === '1') info.databases = ['tally_decoy', ...knownDatabases()];
  return info;
}

function stripLeadingNoise(sql) {
  let rest = sql;
  for (;;) {
    const next = rest
      .replace(/^\s+/, '')
      .replace(/^--[^\n]*(\n|$)/, '')
      .replace(/^\/\*[\s\S]*?\*\//, '');
    if (next === rest) return rest;
    rest = next;
  }
}

function checkSql(sql) {
  if (typeof sql !== 'string') throw new ToolError('sql must be a string');
  const body = stripLeadingNoise(sql);
  if (!/^select\b/i.test(body)) throw new ToolError('sql must be a single SELECT statement');
  const semicolon = body.indexOf(';');
  if (semicolon !== -1 && body.slice(semicolon + 1).trim() !== '') {
    throw new ToolError('sql must be exactly one statement');
  }
  if (FORBIDDEN_WORDS.test(body)) {
    throw new ToolError('sql contains a forbidden keyword (read-only SELECT only)');
  }
  return body;
}

function checkDatabase(database) {
  if (typeof database !== 'string' || database.length > 64 || !DATABASE_NAME.test(database)) {
    throw new ToolError('database must be a string matching ^tally_[a-z0-9_]+$ (at most 64 characters)');
  }
  const path = resolve('data', `${database}.db`);
  if (!existsSync(path)) throw new ToolError(`database ${database} does not exist`);
  return path;
}

function dbQuery({ database, sql } = {}) {
  const path = checkDatabase(database);
  const statement = checkSql(sql);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const prepared = db.prepare(statement);
    const columns =
      typeof prepared.columns === 'function' ? prepared.columns().map((column) => column.name) : null;
    const rows = [];
    let truncated = false;
    let names = columns;
    for (const row of prepared.iterate()) {
      if (rows.length === MAX_ROWS) {
        truncated = true;
        break;
      }
      names ??= Object.keys(row);
      rows.push(Object.values(row));
    }
    const result = { columns: names ?? [], rows };
    if (truncated) result.truncated = true;
    return result;
  } catch (error) {
    throw new ToolError(`sql failed: ${error.message}`);
  } finally {
    db.close();
  }
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ToolError('port must be an integer between 1 and 65535');
  }
}

function checkPath(path) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /\s/.test(path) ||
    path.includes('://') ||
    path.includes('\\')
  ) {
    throw new ToolError('path must start with a single "/" and contain no whitespace, backslash or "://"');
  }
}

async function httpGet({ port, path } = {}) {
  checkPort(port);
  checkPath(path);
  const url = new URL(`http://127.0.0.1:${port}${path}`);
  if (url.hostname !== '127.0.0.1' || url.port !== String(port)) {
    throw new ToolError('path must not change the host or port');
  }
  let response;
  let text;
  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timed out' : (error.cause?.code ?? error.message);
    throw new ToolError(`port ${port} request failed: ${reason}`);
  }
  let body = text;
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

const HANDLERS = { server_info: serverInfo, db_query: dbQuery, http_get: httpGet };

const textResult = (value, isError = false) => {
  const result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
  if (isError) result.isError = true;
  return result;
};

async function callTool(params) {
  const handler = Object.hasOwn(HANDLERS, params?.name) ? HANDLERS[params.name] : undefined;
  if (!handler) return { error: { code: -32602, message: `unknown tool: ${params?.name}` } };
  const delay = Number(process.env.TALLY_MCP_DELAY_MS);
  if (delay > 0) await new Promise((done) => setTimeout(done, delay));
  try {
    return { result: textResult(await handler(params.arguments ?? {})) };
  } catch (error) {
    if (!(error instanceof ToolError)) console.error(`tally-mcp: ${error.stack ?? error}`);
    const message = error instanceof ToolError ? error.message : 'internal error';
    return { result: textResult(message, true) };
  }
}

async function dispatch(message) {
  const { method, params } = message;
  switch (method) {
    case 'initialize':
      return {
        result: {
          protocolVersion:
            typeof params?.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: '1.0.0' },
        },
      };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: TOOLS } };
    case 'tools/call':
      return callTool(params);
    default:
      return { error: { code: -32601, message: `method not found: ${method}` } };
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function handleLine(line) {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
    if (message?.id !== undefined && message?.method === undefined) return; // a response, not for us
    write({ id: message?.id ?? null, error: { code: -32600, message: 'invalid request' } });
    return;
  }
  if (message.id === undefined || message.id === null) return; // notification
  try {
    write({ id: message.id, ...(await dispatch(message)) });
  } catch (error) {
    console.error(`tally-mcp: ${error.stack ?? error}`);
    write({ id: message.id, error: { code: -32603, message: 'internal error' } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  handleLine(line).catch((error) => console.error(`tally-mcp: ${error.stack ?? error}`));
});
