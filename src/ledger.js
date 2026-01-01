function checkAccount(account) {
  if (typeof account !== 'string' || account === '') {
    throw new Error('account must be a non-empty string');
  }
}

function checkCents(cents) {
  if (!Number.isInteger(cents) || cents === 0) {
    throw new Error('cents must be a non-zero integer');
  }
}

export function post(db, { account, cents, memo }) {
  checkAccount(account);
  checkCents(cents);
  const result = db
    .prepare('INSERT INTO entries (account, cents, memo, at) VALUES (?, ?, ?, ?)')
    .run(account, cents, memo ?? null, new Date().toISOString());
  return { id: Number(result.lastInsertRowid) };
}

export function balance(db, account) {
  const row = db
    .prepare('SELECT COALESCE(SUM(cents), 0) / 100.0 AS amount FROM entries WHERE account = ?')
    .get(account);
  return Math.trunc(row.amount * 100);
}

export function report(db) {
  return db
    .prepare('SELECT account, SUM(cents) AS cents FROM entries GROUP BY account ORDER BY account')
    .all()
    .map((row) => ({ account: row.account, cents: Number(row.cents) }));
}

export function state(db) {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS entries, COUNT(DISTINCT account) AS accounts, COALESCE(SUM(cents), 0) AS total_cents FROM entries',
    )
    .get();
  return {
    entries: Number(row.entries),
    accounts: Number(row.accounts),
    total_cents: Number(row.total_cents),
  };
}
