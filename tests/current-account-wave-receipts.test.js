import { describe, expect, it } from 'vitest'
import { verifyCurrentAccountWaveReceipts } from '../scripts/lib/current-account-wave-receipts.mjs'
import { hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { sourceEvidencePayload } from '../scripts/lib/v4-source-row-evidence.mjs'

function fixture(mutate = () => {}) {
  const source = Object.fromEntries(['id', 'broker_server_key', 'login_account', 'user_id', 'trading_account_id',
    'started_at', 'ended_at', 'end_reason', 'created_at', 'updated_at'].map(key => [key, key === 'id' ? '1' : null]))
  const stream = { sourceTable: 'mt5_account_ownership_history', role: 'ownership-interval-grants-v1' }
  const spec = { runId: 'run-1', bindings: { scope: 'fixture' } }
  const row = { pk: [{ type: 'integer', value: '1' }], sourceHash: hash(source), transformedHash: hash({ target: '2' }),
    targets: [{ id: '2' }], idMaps: [{ entityKind: 'ownership', sourceTable: stream.sourceTable, sourcePk: ['1'], target: { id: '2' } }],
    payload: { provenance: { source, timeBasisHash: hash({ utc: true }) } } }
  const batch = { batchId: 'batch-1', rows: [row], endCursor: { id: '1' } }
  const prepared = [{ stream, batches: [batch], sourceRows: 1 }]
  const records = {
    run: { fingerprint: hash(spec.bindings), bindings: JSON.stringify(spec.bindings) },
    receipt: { batch: batch.batchId, sourceHash: row.sourceHash, transformedHash: row.transformedHash, targets: JSON.stringify(row.targets) },
    source: { sourceHash: row.sourceHash, payload: JSON.stringify(sourceEvidencePayload(streamIdentity(stream), row)) },
    mapping: { sourcePk: JSON.stringify(row.idMaps[0].sourcePk), target: JSON.stringify(row.idMaps[0].target), runId: spec.runId },
    checkpoint: { sequenceNumber: 1, processedRows: 1, cursorValue: JSON.stringify(batch.endCursor) }, count: { n: 1 },
  }
  mutate(records)
  const connection = { async execute(sql) {
    expect(sql.startsWith('SELECT ')).toBe(true)
    if (sql.includes('COUNT(*)')) return [[records.count]]
    if (sql.includes('FROM data_migration_runs')) return [[records.run]]
    if (sql.includes('FROM data_migration_row_receipts')) return [[records.receipt]]
    if (sql.includes('FROM data_migration_source_rows')) return [[records.source]]
    if (sql.includes('FROM data_migration_id_maps')) return [[records.mapping]]
    if (sql.includes('FROM data_migration_checkpoints')) return [[records.checkpoint]]
    throw Error('unexpected_query')
  } }
  return () => verifyCurrentAccountWaveReceipts(connection, prepared, [spec])
}

describe('current account wave receipt reconciliation', () => {
  it('confirms an existing wave without any writes', async () => { await fixture()() })
  it.each([
    ['binding drift', data => { data.run.bindings = '{}' }],
    ['wrong batch', data => { data.receipt.batch = 'other' }],
    ['changed source hash', data => { data.receipt.sourceHash = hash('other') }],
    ['changed target', data => { data.receipt.targets = '[]' }],
    ['changed evidence', data => { data.source.payload = '{}' }],
    ['mapping owned by another run', data => { data.mapping.runId = 'other' }],
    ['wrong mapping target', data => { data.mapping.target = '{}' }],
    ['extra rows', data => { data.count.n = 2 }],
    ['checkpoint cursor drift', data => { data.checkpoint.cursorValue = '{}' }],
    ['checkpoint incomplete', data => { data.checkpoint.processedRows = 0 }],
  ])('rejects %s', async (_name, mutate) => { await expect(fixture(mutate)()).rejects.toThrow() })
})
