import assert from 'node:assert/strict'
import { mysqlColumnStore, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export const riskControlTables = ['users', 'global_risk_control', 'global_risk_controls', 'data_migration_runs',
  'data_migration_batches', 'data_migration_checkpoints', 'data_migration_row_receipts', 'data_migration_source_rows']

export function riskControlTargetGuard(upgradeReceipt, baseline) {
  assert.equal(upgradeReceipt.passed, true)
  assert.equal(upgradeReceipt.result.status, 'completed')
  assert.equal(upgradeReceipt.history.length, 175)
  assert.ok(upgradeReceipt.history.every(row => row.status === 'completed'))
  assert.deepEqual(upgradeReceipt.identity, { database: 'dev_vue', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' })
  assert.deepEqual(baseline.identity, upgradeReceipt.identity)
  assert.deepEqual(upgradeReceipt.history.slice(0, 174), baseline.priorHistory)
  const schemas = new Map(baseline.protectedSnapshot.map(row => [row.name, row.schemaSha256]))
  assert.ok(riskControlTables.every(table => /^[a-f0-9]{64}$/.test(schemas.get(table))))
  return async (connection, bindings) => {
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz,CONNECTION_ID() id')
    assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, upgradeReceipt.identity.serverUuid); assert.equal(identity.tz, '+00:00')
    assert.equal(bindings.database, identity.db); assert.equal(bindings.serverUuid, identity.uuid)
    const [[lock]] = await connection.execute('SELECT IS_USED_LOCK(?) owner', ['aurum:inplace:dev_vue'])
    assert.equal(String(lock.owner), String(identity.id))
    assert.equal(await verifyInplaceJournal(connection), true)
    assert.deepEqual(await mysqlColumnStore(connection, true).history(), upgradeReceipt.history)
    // Metadata locks acquired by the transaction's table reads prevent concurrent DDL.
    for (const table of riskControlTables) {
      await connection.query(`SELECT 1 FROM \`${table}\` LIMIT 0`)
      const [[ddl]] = await connection.query(`SHOW CREATE TABLE \`${table}\``)
      assert.equal(tableDefinitionHash(ddl['Create Table']), schemas.get(table))
      const [triggers] = await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [table])
      assert.equal(triggers.length, 0)
    }
  }
}
