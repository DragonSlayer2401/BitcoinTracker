import 'server-only';

const localConnections = new WeakMap();
const acquisitionDelays = [10, 25, 50, 100];

async function reserveLocalConnection(client) {
  const previous = localConnections.get(client) ?? Promise.resolve();
  let release;
  const reserved = new Promise((resolve) => {
    release = resolve;
  });
  localConnections.set(client, reserved);
  await previous;
  return release;
}

/** Share one local connection queue across repositories using the same pooled client. */
export async function runResearchConnectionOperation(client, operation) {
  if (client.protocol !== 'file') return operation();
  const release = await reserveLocalConnection(client);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function beginLocalWrite(client, retryBusy) {
  for (let attempt = 0; ; attempt += 1) {
    let transaction;
    try {
      // libsql 0.5.29 can retain a busy prepared BEGIN IMMEDIATE after a failed lock
      // attempt. Exec reserves the same pooled connection without retaining that statement.
      transaction = await client.transaction('deferred');
      await transaction.executeMultiple('ROLLBACK; BEGIN IMMEDIATE;');
      return transaction;
    } catch (error) {
      transaction?.close();
      if (
        !retryBusy ||
        !/^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(error?.code ?? '') ||
        attempt >= acquisitionDelays.length
      )
        throw error;
      // No application statement has run. Never retry a mutation or an uncertain commit.
      await new Promise((resolve) => setTimeout(resolve, acquisitionDelays[attempt]));
    }
  }
}

async function getResearchTransaction(client, mode, { retryBusy = true } = {}) {
  if (client.protocol !== 'file') return client.transaction(mode);
  const release = await reserveLocalConnection(client);
  let transaction;
  try {
    transaction =
      mode === 'write' ? await beginLocalWrite(client, retryBusy) : await client.transaction(mode);
  } catch (error) {
    release();
    throw error;
  }
  // Releasing the reservation only after the transaction ends prevents independent
  // research, paper-trading and adviser queues from fighting their own SQLite locks.
  return {
    execute: (...args) => transaction.execute(...args),
    executeMultiple: (...args) => transaction.executeMultiple(...args),
    batch: (...args) => transaction.batch(...args),
    get closed() {
      return transaction.closed;
    },
    async commit() {
      const result = await transaction.commit();
      release();
      return result;
    },
    async rollback() {
      const result = await transaction.rollback();
      release();
      return result;
    },
    close() {
      try {
        transaction.close();
      } finally {
        release();
      }
    },
  };
}

/** Reserve a write connection; callers with their own retry budget disable retryBusy. */
export const getResearchWriteTransaction = (client, options) =>
  getResearchTransaction(client, 'write', options);

/** Keep a consistent report snapshot without overlapping this client's local writer. */
export const getResearchReadTransaction = (client) => getResearchTransaction(client, 'read');

export async function runResearchSchemaStatements(client, statements, options) {
  if (client.protocol !== 'file') return client.batch(statements, 'write');
  const transaction = await getResearchWriteTransaction(client, options);
  try {
    for (const statement of statements) await transaction.execute(statement);
    await transaction.commit();
  } finally {
    transaction.close();
  }
}
