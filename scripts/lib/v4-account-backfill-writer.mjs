import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { convertAccountRows } from './v4-account-conversion.mjs'
import { writeExact, accountWriterSchemas as schemas } from './v4-inplace-account-row-store.mjs'

const pk = value => [{ type: 'integer', value }]
// One conversion over the entire frozen set, then pagination. A shared entity has
// identical values in every source row; no batch computes its own min/max or IDs.
export function createAccountBackfill(rows, plan, options, { batchSize = 100, preserveSource = false } = {}) {
  check(typeof preserveSource === 'boolean', 'account_writer_source_mode_invalid')
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
  const transformHash = hash({ version: 'account-writer-v1', conversion: converted.transformHash, schemas, ...(preserveSource ? { sourceEvidenceVersion: 1 } : {}) })
  const batches = []
  let cursor = null
  for (let offset = 0; offset < preparedRows.length; offset += batchSize) {
    const members = preparedRows.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    batches.push({ batchId: hash({ transformHash, content }), ...content }); cursor = content.endCursor
  }
  // Closed-over authoritative rows cannot be changed through returned batches.
  const expected = new Map(preparedRows.map(row => [canonical(row.pk), canonical(row)]))
  const writer = { storageMode: preserveSource ? 'inplace-account-v2' : 'inplace-account-v1', transformHash,
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
