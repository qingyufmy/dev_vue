import { hash } from './v4-backfill-contract.mjs'

const check = (value, code) => { if (!value) throw Error('legacy_candle_backfill_' + code) }
const numeric = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
const projection = ({ targetKeyHash, payloadHash, target }) => ({ targetKeyHash, payloadHash, target })

export function validateLegacyCandleConversion(conversion) {
  const { planHash, mappings, projections, ...body } = conversion
  check(body.kind === 'legacy-candle-conversion/v1' && hash(body) === planHash, 'plan_hash')
  check(Array.isArray(mappings) && mappings.length <= 100000 && Array.isArray(projections), 'budget')
  check(body.inputRows === mappings.length && body.outputRows === projections.length
    && body.duplicateRows === mappings.length - projections.length, 'counts')
  check(hash(mappings) === body.mappingHash && hash(projections) === body.projectionHash, 'content_hash')
  check(hash(mappings.map(({ legacyCandleId, sourceHash }) => ({ legacyCandleId, sourceHash }))) === body.sourceRowsHash, 'source_hash')
  const keys = new Map(projections.map(row => [row.targetKeyHash, row]))
  check(keys.size === projections.length, 'duplicate_projection')
  let previous = '0'
  const firstIds = new Map()
  for (const row of mappings) {
    check(typeof row.legacyCandleId === 'string' && /^[1-9]\d*$/.test(row.legacyCandleId)
      && numeric(row.legacyCandleId, previous) > 0, 'mapping_order')
    previous = row.legacyCandleId
    const target = keys.get(row.targetKeyHash)
    check(target && target.payloadHash === row.payloadHash, 'mapping_target')
    if (!firstIds.has(row.targetKeyHash)) firstIds.set(row.targetKeyHash, row.legacyCandleId)
  }
  for (const row of projections) {
    const t = row.target
    check(row.payloadHash === hash(t) && row.targetKeyHash === hash([t.trading_account_id, t.symbol, t.timeframe, t.open_time_utc]), 'projection_hash')
    check(firstIds.get(row.targetKeyHash) === row.representativeId, 'representative')
  }
  return conversion
}

function expectedPrefix(plan, size) {
  const mappings = plan.mappings.slice(0, size), keys = new Set(mappings.map(row => row.targetKeyHash))
  const projections = plan.projections.filter(row => keys.has(row.targetKeyHash)).map(projection)
    .sort((a, b) => a.targetKeyHash.localeCompare(b.targetKeyHash))
  return { mappings, projections, checkpoint: { planHash: plan.planHash, mappedRows: mappings.length,
    projectionRows: projections.length, lastLegacyId: mappings.at(-1)?.legacyCandleId ?? '0' } }
}

// The MySQL adapter must independently regenerate the approved conversion from
// frozen source rows, hold the upgrade lock and verify all schemas/history.
// readState returns the entire bounded build area; a checkpoint alone is not proof.
export async function inspectLegacyCandleBackfill(store, plan) {
  validateLegacyCandleConversion(plan)
  await store.verifyPlan(plan)
  const state = await store.readState()
  if (state === null) {
    await store.verifyEmpty()
    return { status: 'pending', ...expectedPrefix(plan, 0).checkpoint }
  }
  check(state.checkpoint?.planHash === plan.planHash, 'foreign_plan')
  const size = state.checkpoint.mappedRows
  check(Number.isSafeInteger(size) && size >= 0 && size <= plan.inputRows, 'checkpoint_count')
  const expected = expectedPrefix(plan, size)
  check(hash(state.checkpoint) === hash(expected.checkpoint), 'checkpoint_drift')
  check(['filling', 'verified'].includes(state.status), 'status')
  check(Array.isArray(state.mappings) && Array.isArray(state.projections), 'state_shape')
  const mappings = [...state.mappings].sort((a, b) => numeric(a.legacyCandleId, b.legacyCandleId))
  const projections = [...state.projections].sort((a, b) => a.targetKeyHash.localeCompare(b.targetKeyHash))
  check(hash(mappings) === hash(expected.mappings) && hash(projections) === hash(expected.projections), 'persisted_prefix_drift')
  check(state.status !== 'verified' || size === plan.inputRows, 'premature_verified')
  return { status: state.status, ...expected.checkpoint }
}

// applyBatch must lock the singleton row and atomically compare the expected
// checkpoint, insert/compare projections, insert every mapping and advance it.
// A lost acknowledgement stops this process; the next call re-reads actual data.
export async function backfillLegacyCandles(store, plan, { apply = false, batchSize = 500 } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'batch_size')
  let state = await inspectLegacyCandleBackfill(store, plan), batches = 0
  if (!apply || state.status === 'verified') return { ...state, batches }
  do {
    const size = Math.min(plan.inputRows, state.mappedRows + batchSize)
    const next = expectedPrefix(plan, size)
    const mappings = next.mappings.slice(state.mappedRows)
    const keys = new Set(mappings.map(row => row.targetKeyHash))
    const projections = next.projections.filter(row => keys.has(row.targetKeyHash))
    if (mappings.length || state.status === 'pending') {
      await store.verifyPlan(plan)
      try { await store.applyBatch(plan, state, { mappings, projections, checkpoint: next.checkpoint }) }
      catch { throw Error('legacy_candle_backfill_commit_unknown') }
      batches++
      state = await inspectLegacyCandleBackfill(store, plan)
      check(state.mappedRows === size && state.status === 'filling', 'batch_not_applied')
    }
  } while (state.mappedRows < plan.inputRows)
  await store.verifyPlan(plan)
  try { await store.markVerified(plan, state) }
  catch { throw Error('legacy_candle_backfill_verify_unknown') }
  state = await inspectLegacyCandleBackfill(store, plan)
  check(state.status === 'verified', 'verification_not_applied')
  return { ...state, batches }
}
