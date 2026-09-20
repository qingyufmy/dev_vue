import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

const check = (value, code) => { if (!value) throw Error(`history_runtime_${code}`) }

// The adapter must verify the frozen plan, database identity and held exclusive lock.
// All new tables stay empty until the complete batch has been accepted.
export async function inspectHistoryRuntimeUpgrade(store, plan) {
  await store.verifyPlan(plan)
  const history = await store.history(), entries = validateColumnHistory(history, plan.steps)
  check(plan.prior.steps.every(step => entries.get(step.id)?.status === 'completed'), 'prior_incomplete')
  const priorIds = new Set(plan.prior.steps.map(step => step.id))
  await store.verifyPrior(history.filter(row => priorIds.has(row.id)))
  await store.verifyProtected()
  const expected = new Map(Object.keys(plan.finalTableHashes).map(table => [table, null]))
  let next = null
  for (const step of plan.added) {
    if (entries.get(step.id)?.status === 'completed') expected.set(step.table, step.afterHash)
    else { next = step; break }
  }
  const recorded = next !== null && entries.get(next.id)?.status === 'started'
  let reconciled = false
  for (const [table, beforeHash] of expected) {
    const actual = await store.tableState(table)
    if (actual !== null) {
      check(Number.isSafeInteger(actual.rows) && actual.rows >= 0, 'row_count_invalid')
      if (next !== null) check(actual.rows === 0, 'populated_table')
    }
    if (recorded && table === next.table && actual?.hash === next.afterHash) {
      reconciled = true
    } else {
      check(beforeHash === null ? actual === null : actual?.hash === beforeHash, 'table_conflict')
    }
  }
  return next === null ? { status: 'completed' } : {
    status: reconciled ? 'reconcile' : 'pending', step: next, recorded,
  }
}

export async function coordinateHistoryRuntimeUpgrade(store, plan, { apply = false } = {}) {
  const inspect = () => inspectHistoryRuntimeUpgrade(store, plan)
  let state = await inspect(), ddlCount = 0
  if (!apply) return { status: state.status, ddlCount }
  while (state.status !== 'completed') {
    const step = state.step
    if (state.status === 'pending') {
      if (!state.recorded) {
        try { await store.begin(step) } catch (cause) { throw Error('history_runtime_begin_unknown', { cause }) }
      }
      state = await inspect()
      check(state.status === 'pending' && state.recorded && state.step.id === step.id, 'precondition_changed')
      try { await store.execute(step); ddlCount++ } catch (cause) { throw Error('history_runtime_ddl_unknown', { cause }) }
      state = await inspect()
    }
    check(state.status === 'reconcile' && state.step.id === step.id, 'postcondition_failed')
    try { await store.complete(step) } catch (cause) { throw Error('history_runtime_complete_unknown', { cause }) }
    state = await inspect()
    check(state.status === 'completed' || state.step.id !== step.id, 'completion_not_recorded')
  }
  return { status: 'completed', ddlCount }
}
