import 'server-only';

/** Reserve a write connection without retaining a failed native BEGIN statement. */
export async function getResearchWriteTransaction(client) {
  if (client.protocol !== 'file') return client.transaction('write');
  // libsql 0.5.29 can retain a busy prepared BEGIN IMMEDIATE after a failed lock attempt,
  // poisoning later commits on that connection. Keep the same pooled connection while
  // reserving the write lock through exec instead; no reads or writes occur before it.
  const transaction = await client.transaction('deferred');
  try {
    await transaction.executeMultiple('ROLLBACK; BEGIN IMMEDIATE;');
    return transaction;
  } catch (error) {
    transaction.close();
    throw error;
  }
}

export async function runResearchSchemaStatements(client, statements) {
  if (client.protocol !== 'file') return client.batch(statements, 'write');
  const transaction = await getResearchWriteTransaction(client);
  try {
    for (const statement of statements) await transaction.execute(statement);
    await transaction.commit();
  } finally {
    transaction.close();
  }
}
