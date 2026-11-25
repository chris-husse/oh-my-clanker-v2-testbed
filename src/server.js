import { createServer } from 'node:http';
import { post, balance, state } from './ledger.js';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 'invalid JSON' };
  }
}

function validateEntry(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  if (typeof body.account !== 'string' || body.account === '') {
    return 'account must be a non-empty string';
  }
  if (typeof body.cents !== 'number' || !Number.isInteger(body.cents) || body.cents === 0) {
    return 'cents must be a non-zero integer number';
  }
  return null;
}

async function postEntry(db, req, res) {
  const parsed = parseJson(await readBody(req));
  if (parsed.error) return send(res, 400, { error: parsed.error });
  const problem = validateEntry(parsed.value);
  if (problem) return send(res, 400, { error: problem });
  const { account, cents, memo } = parsed.value;
  send(res, 201, post(db, { account, cents, memo }));
}

function getBalance(db, account, res) {
  send(res, 200, { account, cents: balance(db, account) });
}

function getState(db, res) {
  send(res, 200, state(db));
}

async function route(db, req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && pathname === '/entries') return postEntry(db, req, res);
  if (req.method === 'GET' && pathname.startsWith('/balance/')) {
    return getBalance(db, decodeURIComponent(pathname.slice('/balance/'.length)), res);
  }
  if (req.method === 'GET' && pathname === '/state') return getState(db, res);
  send(res, 404, { error: 'not found' });
}

export function startServer({ db, port }) {
  const server = createServer((req, res) => {
    route(db, req, res).catch(() => send(res, 500, { error: 'internal error' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
