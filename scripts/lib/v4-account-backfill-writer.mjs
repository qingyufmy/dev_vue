import { canonical, exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { convertAccountRows } from './v4-account-conversion.mjs'
import { inplaceAccountTable } from './mysql-inplace-account-backfill.mjs'

const pk = value => [{ type: 'integer', value }]
const schemas = {
  trading_accounts: { keys: ['id'], integers: ['id', 'ownership_revision'], dates: ['created_at_utc', 'updated_at_utc', 'deleted_at_utc'],
    columns: ['id', 'platform', 'broker_server', 'account_login', 'currency', 'margin_mode', 'created_at_utc', 'updated_at_utc', 'deleted_at_utc', 'ownership_revision'] },
  user_trading_account_settings: { keys: ['user_id', 'trading_account_id'], integers: ['user_id', 'trading_account_id', 'hidden', 'legacy_is_deleted', 'connection_paused', 'revision'],
    dates: ['observed_until_utc', 'identity_verified_at_utc', 'first_verified_at_utc', 'updated_at_utc'],
    columns: ['user_id', 'trading_account_id', 'nickname', 'review_status', 'observe_status', 'anomaly_code', 'hidden', 'legacy_is_deleted', 'connection_paused',
      'observed_until_utc', 'identity_verified_at_utc', 'first_verified_at_utc', 'revision', 'updated_at_utc'] },
}

async function writeExact(connection, logicalTable, target) {
  const schema = schemas[logicalTable], table = inplaceAccountTable(logicalTable)
  check(schema, 'account_writer_table_invalid'); exactKeys(target, schema.columns)
  const columns = schema.columns.map(name => schema.integers.includes(name) ? `CAST(\`${name}\` AS CHAR) AS \`${name}\``
    : schema.dates.includes(name) ? `DATE_FORMAT(\`${name}\`,'%Y-%m-%d %H:%i:%s.%f') AS \`${name}\`` : `\`${name}\``).join(',')
  const sql = `SELECT ${columns} FROM \`${table}\` WHERE ${schema.keys.map(name => `\`${name}\`=?`).join(' AND ')} FOR UPDATE`
  const values = schema.keys.map(name => target[name])
  const read = async () => {
    const [rows] = await connection.execute(sql, values)
    check(rows.length <= 1, 'account_writer_target_duplicate')
    if (!rows.length) return null
    const row = { ...rows[0] }
    for (const name of schema.dates) if (row[name] !== null) {
      check(typeof row[name] === 'string' && /\.\d{3}000$/.test(row[name]), 'account_writer_time_precision_invalid')
      row[name] = row[name].slice(0, -3)
    }
    return row
  }
  const existing = await read()
  if (existing !== null) {
    check(canonical(existing) === canonical(target), 'account_writer_target_conflict')
    return
  }
  await connection.execute(`INSERT INTO \`${table}\` (${schema.columns.map(name => `\`${name}\``).join(',')}) VALUES (${schema.columns.map(() => '?').join(',')})`,
    schema.columns.map(name => target[name]))
  check(canonical(await read()) === canonical(target), 'account_writer_readback_mismatch')
}

// One conversion over the entire frozen set, then pagination. A shared entity has
// identical values in every source row; no batch computes its own min/max or IDs.
export function createAccountBackfill(rows, plan, options, { batchSize = 100 } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'account_writer_batch_size_invalid')
  const converted = convertAccountRows(rows, plan, options)
  const entityById = new Map(converted.entities.map(entity => [entity.target.id, entity.target]))
  const mappings = new Map(plan.mappings.map(mapping => [mapping.sourcePk[0].value, structuredClone(mapping)]))
  const preparedRows = converted.settings.map(setting => {
    const entity = entityById.get(setting.target.trading_account_id)
    const targets = [{ table: 'trading_accounts', pk: pk(entity.id) },
      { table: 'user_trading_account_settings', pk: [...pk(setting.target.user_id), ...pk(entity.id)] }]
    const payload = { entity, settings: setting.target, provenance: setting.provenance }
    return { pk: pk(setting.sourceId), sourceHash: setting.sourceHash, targets, payload, transformedHash: hash({ payload, targets }),
      idMaps: [mappings.get(setting.sourceId)] }
  })
  const stream = { sourceTable: 'trading_accounts', role: 'account-entity-settings-v1' }
  const transformHash = hash({ version: 'account-writer-v1', conversion: converted.transformHash, schemas })
  const batches = []
  let cursor = null
  for (let offset = 0; offset < preparedRows.length; offset += batchSize) {
    const members = preparedRows.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    batches.push({ batchId: hash({ transformHash, content }), ...content }); cursor = content.endCursor
  }
  // Closed-over authoritative rows cannot be changed through returned batches.
  const expected = new Map(preparedRows.map(row => [canonical(row.pk), canonical(row)]))
  const writer = { storageMode: 'inplace-account-v1', transformHash,
    async write(connection, row) {
      check(expected.get(canonical(row.pk)) === canonical(row), 'account_writer_row_mismatch')
      await writeExact(connection, 'trading_accounts', row.payload.entity)
      await writeExact(connection, 'user_trading_account_settings', row.payload.settings)
      return { transformedHash: row.transformedHash }
    } }
  return { batches: structuredClone(batches), writer, stream, transformHash, sourceHash: converted.sourceHash,
    mappingHash: converted.mappingHash, sourceRows: preparedRows.length, entityCount: converted.entities.length,
    businessWritesPerformed: false, sourceProvenancePersisted: false }
}
