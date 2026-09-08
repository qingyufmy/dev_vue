import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonical, hash } from './v4-backfill-contract.mjs'
import { readAccountRootSnapshot } from './mysql-account-root-snapshot.mjs'
import { sha256 } from './v4-migration-plan.mjs'

const quote = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }
const ledger = { data_migration_runs: 'id', data_migration_checkpoints: 'run_id', data_migration_batches: 'run_id',
  data_migration_id_maps: 'created_run_id', data_migration_row_receipts: 'run_id', data_migration_source_rows: 'run_id' }
const build = { entity: 'trading_accounts_v4_build', settings: 'user_trading_account_settings_v4_build',
  interval: 'trading_account_ownership_intervals_v4_build', grant: 'trading_account_ownerships_v4_build' }

export async function verifyCurrentWaveState(connection, baseline, runIds, prepared, complete = false) {
  assert.equal(runIds.length, 2)
  const snapshot = await readAccountRootSnapshot(connection)
  assert.deepEqual(snapshot.tables.map(table => table.name), baseline.tables.map(table => table.name))
  const projections = []
  for (const table of snapshot.tables) {
    const expected = baseline.tables.find(item => item.name === table.name)
    if (Object.values(build).includes(table.name)) continue
    assert.equal(sha256(table.ddl), expected.ddlSha256)
    if (!Object.hasOwn(ledger, table.name)) {
      assert.equal(table.rows, expected.rows); assert.equal(table.rowsSha256, expected.rowsSha256); continue
    }
    const meta = snapshot.metadata.get(table.name)
    const digest = createHash('sha256'); let count = 0
    const stream = connection.connection.query({ sql: `SELECT ${meta.columns.map(quote).join(',')} FROM ${quote(table.name)} WHERE ${quote(ledger[table.name])} NOT IN (?,?) ORDER BY ${meta.primary.map(quote).join(',')}`,
      values: runIds, rowsAsArray: true }).stream({ highWaterMark: 16 })
    for await (const row of stream) { digest.update(JSON.stringify(row)); digest.update('\n'); count++ }
    assert.equal(count, expected.rows); assert.equal(digest.digest('hex'), expected.rowsSha256)
  }
  for (const [payloadKey, tableName] of Object.entries(build)) {
    const meta = snapshot.metadata.get(tableName), expected = new Map()
    const key = row => canonical(meta.primary.map(name => row[name]))
    for (const stream of prepared) for (const batch of stream.batches) for (const source of batch.rows) {
      const row = source.payload[payloadKey]
      if (!row) continue
      if (expected.has(key(row))) assert.equal(canonical(expected.get(key(row))), canonical(row))
      expected.set(key(row), row)
    }
    // Generated columns are database-derived; the writer's target contains only
    // writable fields. Their definitions remain covered by the schema coordinator.
    const writable = meta.metadata.filter(column => !(column.extra ?? '').includes('GENERATED'))
    const columns = writable.map(column => ['int', 'bigint', 'tinyint', 'smallint'].includes(column.data_type)
      ? `CAST(${quote(column.column_name)} AS CHAR) ${quote(column.column_name)}`
      : column.data_type === 'datetime' ? `DATE_FORMAT(${quote(column.column_name)},'%Y-%m-%d %H:%i:%s.%f') ${quote(column.column_name)}` : quote(column.column_name))
    const [rows] = await connection.query(`SELECT ${columns.join(',')} FROM ${quote(tableName)} ORDER BY ${meta.primary.map(quote).join(',')}`)
    for (const row of rows) {
      for (const column of writable) if (column.data_type === 'datetime' && row[column.column_name] !== null) {
        assert.match(row[column.column_name], /\.\d{3}000$/); row[column.column_name] = row[column.column_name].slice(0, -3)
      }
      assert.ok(expected.has(key(row))); assert.equal(canonical(row), canonical(expected.get(key(row))))
    }
    if (complete) assert.equal(rows.length, expected.size)
    projections.push({ table: tableName, rows: rows.length, expectedRows: expected.size, sha256: hash(rows.map(canonical).sort()) })
  }
  return { protectedTables: snapshot.tables.length - Object.keys(build).length - Object.keys(ledger).length,
    priorLedgerTablesPreserved: Object.keys(ledger).length, projections }
}
