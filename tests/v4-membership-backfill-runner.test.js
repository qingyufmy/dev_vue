import { describe, expect, it } from 'vitest'
import { BackfillError, canonical, hash, prepareBatch, streamIdentity } from '../scripts/lib/v4-membership-backfill-contract.mjs'
import { executeBackfillBatch, prepareBackfillRun, recoverBackfillBatch } from '../scripts/lib/v4-membership-backfill-runner.mjs'

const pk = value => [{ type: 'integer', value: String(value) }]
const spec = () => ({
  runId: '11111111-1111-1111-1111-111111111111', admission: { approved: true, blockers: [] },
  bindings: { logicalSourceId: 'legacy', sourceDatabase: 'source', mirrorDatabase: 'frozen', snapshotHash: 'a'.repeat(64),
    targetServerUuid: '22222222-2222-2222-2222-222222222222', targetDatabase: 'source', storageMode: 'inplace-membership-v1', schemaHash: 'b'.repeat(64),
    manifestHash: 'c'.repeat(64), transformHash: 'd'.repeat(64), streams: [{ sourceTable: 'users', role: 'membership-v1' }] },
})
function batch(number = 1) {
  const targets = [{ table: 'memberships', pk: pk(number) }]
  const payload = { name: 'fixture-' + number, amount: '9007199254740993.00000001' }
  return { batchId: hash('batch-' + number), stream: spec().bindings.streams[0], sequence: number, startCursor: number === 1 ? null : pk(number - 1), endCursor: pk(number),
    rows: [{ pk: pk(number), sourceHash: hash('original-bytes-' + number), targets, payload, transformedHash: hash({ payload, targets }),
      idMaps: [{ entityKind: 'user', sourceTable: 'users', sourcePk: pk(number), target: targets[0] }] }] }
}

// Serialized transactional state including the business writer; commit fault modes are deliberate.
class MemoryRepository {
  state = { runs: {}, checkpoints: {}, batches: {}, maps: {}, receipts: {}, business: {} }
  transactions = 0
  mode = null
  target = { storageMode: 'inplace-membership-v1', database: 'source', serverUuid: spec().bindings.targetServerUuid, schemaHash: spec().bindings.schemaHash }
  tail = Promise.resolve()
  async transaction(work) {
    const prior = this.tail
    let release
    this.tail = new Promise(resolve => { release = resolve })
    await prior
    try {
      this.transactions++
      if (this.mode === 'unavailable') throw new BackfillError('backfill_storage_failed')
      if (this.mode === 'deadlock') { this.mode = null; throw new BackfillError('backfill_deadlock_rolled_back') }
      const state = structuredClone(this.state)
      const key = (...parts) => canonical(parts)
      const mapKey = (logical, m) => key(logical, m.entityKind, m.sourceTable, hash(m.sourcePk))
      const tx = {
        connection: state,
        targetIdentity: async () => this.target,
        findRun: async id => state.runs[id],
        insertRun: async (id, bindings, bindingsHash) => { state.runs[id] = { bindings, bindingsHash } },
        insertCheckpoint: async (run, stream) => { state.checkpoints[key(run, stream)] = { sequence: 0, cursor: null, processedRows: '0' } },
        findCheckpoint: async (run, stream) => state.checkpoints[key(run, stream)],
        findBatch: async (run, id) => state.batches[key(run, id)],
        insertBatch: async (run, b) => { state.batches[key(run, b.batchId)] = b },
        findMapping: async (logical, m) => state.maps[mapKey(logical, m)],
        insertMapping: async (_run, logical, m) => { state.maps[mapKey(logical, m)] = { sourcePk: m.sourcePk, target: m.target } },
        findReceipt: async (run, stream, h) => state.receipts[key(run, stream, h)],
        insertReceipt: async (run, stream, id, row) => { state.receipts[key(run, stream, hash(row.pk))] = { batchId: id, sourceHash: row.sourceHash, transformedHash: row.transformedHash } },
        advanceCheckpoint: async (run, stream, _previous, sequence, cursor, processedRows) => { state.checkpoints[key(run, stream)] = { sequence, cursor, processedRows } },
      }
      const result = await work(tx)
      if (this.mode === 'commit-before') { this.mode = null; throw new BackfillError('backfill_commit_unknown') }
      this.state = state
      if (this.mode === 'commit-after') { this.mode = null; throw new BackfillError('backfill_commit_unknown') }
      return result
    } finally { release() }
  }
}
function writer() {
  return { storageMode: 'inplace-membership-v1', transformHash: spec().bindings.transformHash, calls: 0, fail: false,
    async write(connection, row) {
      this.calls++
      const key = canonical(row.targets[0])
      if (connection.business[key] && canonical(connection.business[key]) !== canonical(row.payload)) throw new BackfillError('fixture_business_conflict')
      connection.business[key] = row.payload
      if (this.fail) throw new BackfillError('fixture_writer_failed')
      return { transformedHash: row.transformedHash }
    } }
}
async function setup() { const repo = new MemoryRepository(); await prepareBackfillRun(repo, spec()); return repo }

describe('backfill transaction and recovery contract (no real database)', () => {
  it('rejects unapproved waves and a different target database before any transaction', async () => {
    const repo = new MemoryRepository(), s = spec()
    s.admission.blockers.push('G-TIME')
    await expect(prepareBackfillRun(repo, s)).rejects.toMatchObject({ code: 'backfill_wave_not_approved' })
    s.admission.blockers = []; s.bindings.targetDatabase = 'another_database'
    await expect(prepareBackfillRun(repo, s)).rejects.toMatchObject({ code: 'backfill_inplace_scope_invalid' })
    expect(repo.transactions).toBe(0)
  })
  it('preserves bindings on repeated preparation and rejects snapshot/manifest changes', async () => {
    const repo = await setup()
    expect((await prepareBackfillRun(repo, spec())).existing).toBe(true)
    for (const field of ['snapshotHash', 'manifestHash', 'transformHash']) {
      const s = spec(); s.bindings[field] = 'e'.repeat(64)
      await expect(prepareBackfillRun(repo, s)).rejects.toMatchObject({ code: 'backfill_run_bindings_mismatch' })
    }
  })
  it('rejects wrong instance/schema and stale cursors without business writes', async () => {
    const repo = await setup(), w = writer()
    repo.target.schemaHash = 'e'.repeat(64)
    await expect(executeBackfillBatch(repo, spec(), batch(), w)).rejects.toMatchObject({ code: 'backfill_schema_drift' })
    repo.target.schemaHash = spec().bindings.schemaHash
    repo.target.database = 'other'
    await expect(executeBackfillBatch(repo, spec(), batch(), w)).rejects.toMatchObject({ code: 'backfill_target_identity_mismatch' })
    repo.target.database = 'source'
    await expect(executeBackfillBatch(repo, spec(), batch(2), w)).rejects.toMatchObject({ code: 'backfill_checkpoint_conflict' })
    expect(w.calls).toBe(0)
  })
  it('commits business, map, receipt, batch and checkpoint once under concurrent duplicate calls', async () => {
    const repo = await setup(), w = writer()
    const results = await Promise.all([executeBackfillBatch(repo, spec(), batch(), w), executeBackfillBatch(repo, spec(), batch(), w)])
    expect(results[0]).toEqual(results[1]); expect(w.calls).toBe(1)
    for (const key of ['business', 'maps', 'receipts', 'batches']) expect(Object.keys(repo.state[key])).toHaveLength(1)
    expect(Object.values(repo.state.checkpoints)[0]).toMatchObject({ sequence: 1, processedRows: '1' })
  })
  it('rolls back every component when the writer fails and permits an explicit retry', async () => {
    const repo = await setup(), before = structuredClone(repo.state), w = writer()
    w.fail = true
    await expect(executeBackfillBatch(repo, spec(), batch(), w)).rejects.toMatchObject({ code: 'fixture_writer_failed' })
    expect(repo.state).toEqual(before)
    w.fail = false
    expect((await executeBackfillBatch(repo, spec(), batch(), w)).status).toBe('committed')
  })
  it('rejects same batch ID with different content and duplicate row disposal in another batch', async () => {
    const repo = await setup(), w = writer()
    await executeBackfillBatch(repo, spec(), batch(), w)
    const changed = batch(); changed.rows[0].sourceHash = 'e'.repeat(64)
    await expect(executeBackfillBatch(repo, spec(), changed, w)).rejects.toMatchObject({ code: 'backfill_batch_content_conflict' })
    const repeated = batch(2); repeated.rows.unshift(batch().rows[0])
    await expect(executeBackfillBatch(repo, spec(), repeated, w)).rejects.toMatchObject({ code: 'backfill_row_already_disposed' })
    expect(w.calls).toBe(1)
  })
  it('retains mapping identity across runs and rejects remapping the same source key', async () => {
    const repo = await setup(), w = writer()
    await executeBackfillBatch(repo, spec(), batch(), w)
    const next = spec(); next.runId = '33333333-3333-3333-3333-333333333333'; next.bindings.snapshotHash = 'e'.repeat(64)
    await prepareBackfillRun(repo, next)
    const changed = batch(); changed.rows[0].targets[0].pk = pk(99); changed.rows[0].idMaps[0].target = changed.rows[0].targets[0]
    changed.rows[0].transformedHash = hash({ payload: changed.rows[0].payload, targets: changed.rows[0].targets })
    await expect(executeBackfillBatch(repo, next, changed, w)).rejects.toMatchObject({ code: 'backfill_id_map_conflict' })
    expect(Object.keys(repo.state.maps)).toHaveLength(1)
  })
  it.each(['commit-before', 'commit-after'])('resolves %s loss without automatic writer replay', async mode => {
    const repo = await setup(), w = writer(); repo.mode = mode
    await expect(executeBackfillBatch(repo, spec(), batch(), w)).rejects.toMatchObject({ code: 'backfill_commit_unknown' })
    expect(w.calls).toBe(1)
    const recovered = await recoverBackfillBatch(repo, spec(), batch())
    expect(recovered.status).toBe(mode === 'commit-after' ? 'committed' : 'not_committed')
    expect(w.calls).toBe(1)
    await executeBackfillBatch(repo, spec(), batch(), w)
    expect(w.calls).toBe(mode === 'commit-after' ? 1 : 2)
  })
  it('keeps unknown during storage failure and only retries acknowledged deadlock rollback', async () => {
    const repo = await setup(), w = writer(); repo.mode = 'unavailable'
    expect((await recoverBackfillBatch(repo, spec(), batch())).status).toBe('unknown')
    repo.mode = 'deadlock'
    expect((await executeBackfillBatch(repo, spec(), batch(), w)).status).toBe('committed')
    expect(w.calls).toBe(1)
  })
  it('caps confirmed deadlock retries and never calls the writer without a transaction', async () => {
    const repo = await setup(), w = writer()
    let attempts = 0
    repo.transaction = async () => { attempts++; throw new BackfillError('backfill_deadlock_rolled_back') }
    await expect(executeBackfillBatch(repo, spec(), batch(), w)).rejects.toMatchObject({ code: 'backfill_deadlock_rolled_back' })
    expect(attempts).toBe(3); expect(w.calls).toBe(0)
  })
  it('rolls back when writer acknowledgement disagrees with transformed evidence', async () => {
    const repo = await setup(), before = structuredClone(repo.state), w = writer()
    const write = w.write.bind(w)
    w.write = async (...args) => { await write(...args); return { transformedHash: 'e'.repeat(64) } }
    await expect(executeBackfillBatch(repo, spec(), batch(), w)).rejects.toMatchObject({ code: 'backfill_writer_receipt_mismatch' })
    expect(repo.state).toEqual(before)
  })
  it('does not report a changed recovery request or advanced checkpoint as safe to replay', async () => {
    const repo = await setup(), w = writer()
    await executeBackfillBatch(repo, spec(), batch(), w)
    const changed = batch(); changed.rows[0].sourceHash = 'e'.repeat(64)
    await expect(recoverBackfillBatch(repo, spec(), changed)).rejects.toMatchObject({ code: 'backfill_batch_content_conflict' })
    const differentId = batch(); differentId.batchId = hash('other-id')
    await expect(recoverBackfillBatch(repo, spec(), differentId)).rejects.toMatchObject({ code: 'backfill_recovery_checkpoint_conflict' })
    expect(w.calls).toBe(1)
  })
  it('keeps large integer and composite PKs exact and rejects unsafe numeric input', () => {
    const b = batch(), key = [{ type: 'integer', value: '900719925474099312345' }, { type: 'text', value: 'server:甲|乙' }]
    b.rows[0].pk = key; b.rows[0].idMaps[0].sourcePk = key; b.endCursor = key
    expect(prepareBatch(spec(), b).streamId).toBe(streamIdentity(b.stream))
    b.rows[0].payload.amount = 0.1
    expect(() => prepareBatch(spec(), b)).toThrow('backfill_non_integral_number')
  })
  it('rejects row/byte excess and cross-row ID mappings', () => {
    const many = batch(); many.rows = Array(501).fill(many.rows[0])
    expect(() => prepareBatch(spec(), many)).toThrow('backfill_row_limit')
    const large = batch(); large.rows[0].payload.name = 'x'.repeat(2 * 1024 * 1024)
    large.rows[0].transformedHash = hash({ payload: large.rows[0].payload, targets: large.rows[0].targets })
    expect(() => prepareBatch(spec(), large)).toThrow('backfill_byte_limit')
    const wrong = batch(); wrong.rows[0].idMaps[0].sourcePk = pk(2)
    expect(() => prepareBatch(spec(), wrong)).toThrow('backfill_map_source_mismatch')
  })
})
