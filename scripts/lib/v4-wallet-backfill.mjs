import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { createWalletAddressWriter } from './mysql-wallet-address-writer.mjs'

const pk = value => [{ type: 'integer', value }]
export function createWalletBackfill(rows, options, { batchSize = 100 } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'wallet_batch_size_invalid')
  options = structuredClone(options)
  const inner = createWalletAddressWriter(rows, options), stream = { sourceTable: 'wallet_keys', role: 'wallet-v1' }
  const transformHash = hash({ version: 'wallet-backfill/v1', conversion: inner.prepared.transformHash })
  const prepared = inner.prepared.entries.map(entry => {
    const target = { table: 'payment_wallet_addresses', pk: pk(entry.target.id) }, targets = [target]
    const payload = { entry, run: options.run, resolution: entry.provenance.resolution }
    return { pk: pk(entry.sourceId), sourceHash: entry.sourceHash, targets, payload, transformedHash: hash({ payload, targets }),
      idMaps: [{ entityKind: 'wallet', sourceTable: 'wallet_keys', sourcePk: pk(entry.sourceId), target }] }
  })
  const expected = new Map(prepared.map(row => [canonical(row.pk), canonical(row)])), batches = []
  const validate = row => check(expected.get(canonical(row.pk)) === canonical(row), 'wallet_batch_row_changed')
  let cursor = null
  for (let offset = 0; offset < prepared.length; offset += batchSize) {
    const members = prepared.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    batches.push({ batchId: hash({ transformHash, content }), ...content }); cursor = content.endCursor
  }
  const writer = { storageMode: 'inplace-wallet-v1', transformHash, async write(connection, row) {
    validate(row)
    await inner.write(connection, row.payload.entry)
    return { transformedHash: row.transformedHash }
  } }
  const sourceEvidence = (streamId, row) => {
    check(streamId === streamIdentity(stream), 'wallet_evidence_stream')
    validate(row)
    const entry = row.payload.entry
    return structuredClone({ version: 1, sourceTable: 'wallet_keys', projection: 'wallet-source/v1', source: entry.provenance.source,
      sourceSnapshotId: row.payload.run.sourceSnapshotId, registeredAtUtc: row.payload.run.registeredAtUtc,
      basisHash: entry.provenance.basisHash, resolution: row.payload.resolution })
  }
  return { batches: structuredClone(batches), writer, sourceEvidence, stream, transformHash, sourceHash: inner.prepared.sourceHash,
    sourceRows: prepared.length, runId: options.run.id, unresolvedDependencies: inner.prepared.unresolvedDependencies,
    businessWritesPerformed: false }
}
