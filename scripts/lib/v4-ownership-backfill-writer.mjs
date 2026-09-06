import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { convertOwnershipRows } from './v4-ownership-conversion.mjs'
import { writeExact } from './v4-inplace-account-row-store.mjs'

const pk = value => [{ type: 'integer', value }]
const intervalPk = value => [{ type: 'text', value }]

// Project only the final grant for each user/account. Attach it to its selected
// interval so the composite FK always references a row written in this transaction
// or an earlier committed batch; old intervals never grant temporary authority.
export function createOwnershipBackfill(rows, options, { batchSize = 100, expectedSourceIds } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'ownership_writer_batch_size_invalid')
  check(Array.isArray(rows) && Array.isArray(expectedSourceIds), 'ownership_writer_source_incomplete')
  const sourceIds = new Set(expectedSourceIds)
  check(sourceIds.size === expectedSourceIds.length && expectedSourceIds.length === rows.length
    && rows.every(row => sourceIds.has(row.id)), 'ownership_writer_source_incomplete')
  const converted = convertOwnershipRows(rows, options)
  const grantByInterval = new Map(converted.grants.map(grant => [grant.interval_id, grant]))
  const sourceById = new Map(rows.map(row => [row.id, row]))
  const preparedRows = converted.entries.map(entry => {
    const grant = grantByInterval.get(entry.target.id) ?? null
    const targets = [{ table: 'trading_account_ownership_intervals', pk: intervalPk(entry.target.id) }]
    if (grant) targets.push({ table: 'trading_account_ownerships', pk: [...pk(grant.user_id), ...pk(grant.trading_account_id), { type: 'text', value: grant.role }] })
    const payload = { interval: entry.target, grant, provenance: { ...entry.provenance, source: { ...sourceById.get(entry.sourceId) } } }
    return { pk: pk(entry.sourceId), sourceHash: entry.sourceHash, payload, targets, transformedHash: hash({ payload, targets }),
      idMaps: [{ entityKind: 'ownership_interval', sourceTable: 'mt5_account_ownership_history', sourcePk: pk(entry.sourceId), target: targets[0] }] }
  })
  const stream = { sourceTable: 'mt5_account_ownership_history', role: 'ownership-interval-grants-v1' }
  const transformHash = hash({ version: 'ownership-writer-v1', conversion: converted.transformationHash })
  const batches = []
  let cursor = null
  for (let offset = 0; offset < preparedRows.length; offset += batchSize) {
    const members = preparedRows.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    batches.push({ batchId: hash({ transformHash, content }), ...content }); cursor = content.endCursor
  }
  const expected = new Map(preparedRows.map(row => [canonical(row.pk), canonical(row)]))
  const writer = { storageMode: 'inplace-account-v1', transformHash, async write(connection, row) {
    check(expected.get(canonical(row.pk)) === canonical(row), 'ownership_writer_row_mismatch')
    await writeExact(connection, 'trading_account_ownership_intervals', row.payload.interval)
    if (row.payload.grant) await writeExact(connection, 'trading_account_ownerships', row.payload.grant)
    return { transformedHash: row.transformedHash }
  } }
  return { writer, batches: structuredClone(batches), stream, transformHash,
    sourceRows: rows.length, grantCount: converted.grants.length, sourceProvenancePersisted: false, businessWritesPerformed: false }
}
