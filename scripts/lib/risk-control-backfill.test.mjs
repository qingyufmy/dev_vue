import test from 'node:test'
import assert from 'node:assert/strict'
import { backfillRiskControl } from './risk-control-backfill.mjs'
import { mapLegacyRiskControl } from './risk-legacy-control-mapping.mjs'

const source = { id: 1, global_kill_switch: 1, reason: '暂停', changed_by: 7, updated_at: '2026-09-09 08:00:00' }
const spec = { runId: '00000000-0000-0000-0000-000000000001',
  sourceSha256: mapLegacyRiskControl([source], new Set(['7'])).sourceSha256,
  bindings: { kind: 'risk-control-backfill/v1', database: 'test' } }

function harness() {
  let state = { source, target: [], run: null, batch: null, archive: [], checkpoint: null, receipt: null }
  const h = { failArchive: false, loseCommit: false, state: () => state }
  h.repository = { async transaction(work) {
    const next = structuredClone(state)
    const connection = {
      async query(sql) {
        if (sql.includes('FROM global_risk_control ')) return [[next.source]]
        if (sql.includes('FROM global_risk_controls ')) return [next.target]
        throw Error('unexpected query')
      },
      async execute(sql, args) {
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }]]
        if (sql.includes('FROM data_migration_source_rows')) return [next.archive]
        if (sql.includes('INSERT INTO global_risk_controls')) { next.target.push(args); return [{}] }
        if (sql.includes('INSERT INTO data_migration_source_rows')) {
          if (h.failArchive) throw Error('archive write failed')
          next.archive.push({ source_bytes_sha256: args[3], source_payload_json: args[4] }); return [{}]
        }
        throw Error('unexpected execute')
      },
    }
    const result = await work({ connection,
      findRun: async () => next.run,
      insertRun: async (_id, bindings, bindingsHash) => { next.run = { bindings, bindingsHash } },
      insertCheckpoint: async () => { next.checkpoint = { sequence: 0, cursor: null, processedRows: '0' } },
      findCheckpoint: async () => next.checkpoint,
      findBatch: async (_run, batchId) => next.batch?.batchId === batchId ? next.batch : null,
      insertBatch: async (_run, batch) => { next.batch = batch },
      insertReceipt: async (...args) => { next.receipt = args },
      advanceCheckpoint: async () => { next.checkpoint = { sequence: 1, cursor: ['1'], processedRows: '1' } },
    })
    state = next
    if (h.loseCommit) { h.loseCommit = false; throw Error('backfill_commit_unknown') }
    return result
  } }
  return h
}

test('archive failure rolls back target, journal and checkpoint together', async () => {
  const h = harness(); h.failArchive = true
  await assert.rejects(backfillRiskControl(h.repository, spec, async () => {}), /archive write failed/)
  assert.equal(h.state().target.length, 0)
  assert.equal(h.state().run, null)
  assert.equal(h.state().receipt, null)
})

test('commit uncertainty replays archive without overwriting subsequent V4 changes', async () => {
  const h = harness(); h.loseCommit = true
  await assert.rejects(backfillRiskControl(h.repository, spec, async () => {}), /commit_unknown/)
  h.state().target = [{ revision: 2, kill_switch: 0 }]
  const result = await backfillRiskControl(h.repository, spec, async () => {})
  assert.equal(result.replay, true)
  assert.deepEqual(h.state().target, [{ revision: 2, kill_switch: 0 }])
  assert.equal(h.state().archive.length, 1)
})

test('source drift, occupied target and failed admission reject all writes', async () => {
  for (const mode of ['source', 'target', 'admission']) {
    const h = harness()
    if (mode === 'source') h.state().source = { ...source, reason: 'changed' }
    if (mode === 'target') h.state().target = [{ id: 1 }]
    const before = structuredClone(h.state())
    await assert.rejects(backfillRiskControl(h.repository, spec, async () => { if (mode === 'admission') throw Error('schema drift') }))
    assert.deepEqual(h.state(), before)
  }
})

test('corrupt archived source cannot pass replay on its stored hash alone', async () => {
  const h = harness()
  await backfillRiskControl(h.repository, spec, async () => {})
  h.state().archive[0].source_payload_json = JSON.stringify({ ...source, reason: 'corrupt' })
  await assert.rejects(backfillRiskControl(h.repository, spec, async () => {}), /archive_corrupt/)
})
