import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { historyCollectionReceipt } from '../../server/dist-v4/modules/trade-history/application/history-collection-receipt.js'
import { persistHistoryCollectionReceipt } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-receipt-writer.js'
import { splitSqlStatements } from './v4-migration-plan.mjs'

export async function verifyHistoryCollectionReceiptReference(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const sql = await readFile(new URL('../../server/db/migrations/inplace/051_history_collection_receipts.sql', import.meta.url), 'utf8')
  const ddl = splitSqlStatements(sql)[0]
  await connection.query(ddl)
  const [[definition]] = await connection.query('SHOW CREATE TABLE terminal_history_collection_receipts_v4')
  const route = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', terminalProfileId: 'profile',
    brokerServer: 'Broker', login: '001', connectionEpoch: 3, connectionId: 'connection', ownershipRevision: '2' }
  const chains = ['history.orders', 'history.deals'].map(resource => ({ resource, rangeStartUtcMsc: 1001, rangeEndUtcMsc: 2002,
    source: 'local_projection', sourceRevision: 'revision_1', pageCount: 2, itemCount: 10, pageChainHash: 'a'.repeat(64) }))
  const receipt = historyCollectionReceipt(route, 2002, chains), checks = []
  const count = async () => Number((await connection.query('SELECT COUNT(*) n FROM terminal_history_collection_receipts_v4'))[0][0].n)
  try {
    await connection.beginTransaction()
    await persistHistoryCollectionReceipt(connection, receipt, new Date(3003))
    await connection.rollback()
    assert.equal(await count(), 0)
    checks.push('receipt-write-rolled-back-with-caller-transaction')
    await connection.beginTransaction()
    const first = await persistHistoryCollectionReceipt(connection, receipt, new Date(3003))
    await connection.commit()
    const [[row]] = await connection.query(`SELECT evidence_sha256,evidence_json,DATE_FORMAT(range_start_utc,'%Y-%m-%d %H:%i:%s.%f') start_utc,
      DATE_FORMAT(range_end_utc,'%Y-%m-%d %H:%i:%s.%f') end_utc FROM terminal_history_collection_receipts_v4`)
    assert.equal(row.evidence_sha256, receipt.hash)
    assert.deepEqual(typeof row.evidence_json === 'string' ? JSON.parse(row.evidence_json) : row.evidence_json, receipt.evidence)
    assert.equal(row.start_utc, '1970-01-01 00:00:01.001000')
    assert.equal(row.end_utc, '1970-01-01 00:00:02.002000')
    checks.push('canonical-body-and-utc-millisecond-roundtrip')
    await connection.beginTransaction()
    assert.deepEqual(await persistHistoryCollectionReceipt(connection, receipt, new Date(4004)), { id: first.id, created: false })
    await connection.commit()
    assert.equal(await count(), 1)
    checks.push('same-digest-replay-does-not-duplicate-receipt')
    await connection.beginTransaction()
    await connection.query("UPDATE terminal_history_collection_receipts_v4 SET evidence_json=JSON_OBJECT()")
    await assert.rejects(persistHistoryCollectionReceipt(connection, receipt, new Date(4004)), { message: 'trade_history_collection_receipt_conflict' })
    await connection.rollback()
    checks.push('corrupt-existing-body-rejected')
    for (const mutation of ["range_end_utc=range_start_utc", 'connection_epoch=0', "evidence_sha256=REPEAT('g',64)"]) {
      await connection.beginTransaction()
      try { await assert.rejects(connection.query(`UPDATE terminal_history_collection_receipts_v4 SET ${mutation}`)) }
      finally { await connection.rollback() }
    }
    checks.push('mysql-window-epoch-and-hash-constraints')
    for (const mutation of ['trading_account_id=999999', 'user_id=999999']) {
      await connection.beginTransaction()
      try { await assert.rejects(connection.query(`UPDATE terminal_history_collection_receipts_v4 SET ${mutation}`), { code: 'ER_NO_REFERENCED_ROW_2' }) }
      finally { await connection.rollback() }
    }
    checks.push('actual-account-and-user-foreign-keys')
    return { passed: true, checks, schema: 'migration-051-full-ddl-with-minimal-reference-parents', foreignKeysVerified: true,
      canonicalDdl: definition['Create Table'], migrationSha256: createHash('sha256').update(sql).digest('hex'), fullCollectorTransactionVerified: false }
  } finally {
    await connection.rollback()
    await connection.query('DROP TABLE terminal_history_collection_receipts_v4')
  }
}
