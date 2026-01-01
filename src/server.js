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

// What the server keeps in memory, never in the database: the balances it served since the last post to their
// account, the cache's counters, and the last request it handled (GET /state left out), as it understood it.
class View {
  constructor() {
    this.balances = new Map();
    this.cache = { hits: 0, misses: 0, invalidations: 0 };
    this.lastRequest = null;
  }

  balance(db, account) {
    if (this.balances.has(account)) {
      this.cache.hits += 1;
      return this.balances.get(account);
    }
    this.cache.misses += 1;
    const cents = balance(db, account);
    this.balances.set(account, cents);
    return cents;
  }

  posted(account) {
    if (this.balances.delete(account)) this.cache.invalidations += 1;
  }
}

async function postEntry(db, view, req, res) {
  const parsed = parseJson(await readBody(req));
  if (parsed.error) return send(res, 400, { error: parsed.error });
  const problem = validateEntry(parsed.value);
  if (problem) return send(res, 400, { error: problem });
  const { account, cents, memo } = parsed.value;
  view.lastRequest = { method: 'POST', path: '/entries', account };
  const created = post(db, { account, cents, memo });
  view.posted(account);
  send(res, 201, created);
}

function getBalance(db, view, segment, res) {
  const account = decodeURIComponent(segment);
  view.lastRequest = { method: 'GET', path: `/balance/${segment}`, account };
  send(res, 200, { account, cents: view.balance(db, account) });
}

function getState(db, view, res) {
  send(res, 200, { ...state(db), cache: { ...view.cache }, last_request: view.lastRequest });
}

async function route(db, view, req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && pathname === '/entries') return postEntry(db, view, req, res);
  if (req.method === 'GET' && pathname.startsWith('/balance/')) {
    return getBalance(db, view, pathname.slice('/balance/'.length), res);
  }
  if (req.method === 'GET' && pathname === '/state') return getState(db, view, res);
  send(res, 404, { error: 'not found' });
}

export function startServer({ db, port }) {
  const view = new View();
  const server = createServer((req, res) => {
    route(db, view, req, res).catch(() => send(res, 500, { error: 'internal error' }));
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
