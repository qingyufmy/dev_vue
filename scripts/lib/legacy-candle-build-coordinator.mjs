import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { coordinateAccountProjectionMigration } from './account-projection-coordinator.mjs'

const check = (condition, code) => { if (!condition) throw Error(`legacy_candle_build_${code}`) }

// The adapter holds the same-connection upgrade lock and verifies a durable plan.
// tableState verifies the complete canonical schema, not just table existence.
// verifyProtected checks the frozen prior rows until all three new steps are complete.
export async function inspectLegacyCandleBuildMigration(store, plan) {
  await store.verifyPlan(plan)
  const history = await store.history()
  const validated = validateColumnHistory(history, plan.steps)
  check(plan.prior.steps.every(step => validated.get(step.id)?.status === 'completed'), 'prior_incomplete')
  const states = []
  for (const step of plan.additions) {
    const entry = validated.get(step.id)
    const table = await store.tableState(step)
    if (table !== null) {
      check(table.matches === true && Number.isSafeInteger(table.rows) && table.rows >= 0, 'table_conflict')
      check(Boolean(entry), 'unrecorded_table')
      if (entry.status !== 'completed') check(table.rows === 0, 'uncompleted_table_has_rows')
    }
    if (entry?.status === 'completed') check(table !== null, 'completed_table_missing')
    states.push({ step, status: entry?.status === 'completed' ? 'completed' : table ? 'reconcile' : 'pending' })
  }
  const priorIds = new Set(plan.prior.steps.map(step => step.id))
  const additionNames = new Set(plan.additions.map(step => step.table))
  const snapshot = await store.priorStore.priorStore.priorStore.rootStore.snapshot()
  // Only exact, separately verified additions may be removed from the old snapshot.
  for (const state of states) {
    const present = snapshot.some(table => table.name === state.step.table)
    check(present === (state.status !== 'pending'), 'snapshot_table_disagreement')
  }
  const priorSnapshot = snapshot.filter(table => !additionNames.has(table.name))
  await store.verifyProtected(priorSnapshot, states.every(state => state.status === 'completed'))
  const prior = await coordinateAccountProjectionMigration({
    ...store.priorStore,
    history: async () => history.filter(row => priorIds.has(row.id)),
    priorStore: { ...store.priorStore.priorStore,
      priorStore: { ...store.priorStore.priorStore.priorStore,
        rootStore: { ...store.priorStore.priorStore.priorStore.rootStore, snapshot: async () => priorSnapshot } } },
  }, plan.prior)
  check(prior.steps.every(step => step.status === 'completed'), 'prior_not_completed')
  return states
}

export async function coordinateLegacyCandleBuildMigration(store, plan, { apply = false } = {}) {
  let states = await inspectLegacyCandleBuildMigration(store, plan)
  if (!apply) return { ddlCount: 0, steps: states.map(({ step, status }) => ({ id: step.id, status })) }
  let ddlCount = 0
  for (const step of plan.additions) {
    // Fresh complete inspection before every step, including recovery after another process.
    states = await inspectLegacyCandleBuildMigration(store, plan)
    const state = states.find(item => item.step.id === step.id)
    if (state.status === 'completed') continue
    if (state.status === 'pending') {
      const history = validateColumnHistory(await store.history(), plan.steps)
      if (!history.has(step.id)) {
        try { await store.begin(step) }
        catch { throw Error('legacy_candle_build_begin_unknown') }
      }
      const checked = await inspectLegacyCandleBuildMigration(store, plan)
      check(checked.find(item => item.step.id === step.id)?.status === 'pending', 'precondition_changed')
      try { await store.execute(step); ddlCount++ }
      catch { throw Error('legacy_candle_build_ddl_unknown') }
    }
    const after = await inspectLegacyCandleBuildMigration(store, plan)
    check(after.find(item => item.step.id === step.id)?.status === 'reconcile', 'postcondition_failed')
    try { await store.complete(step) }
    catch { throw Error('legacy_candle_build_complete_unknown') }
  }
  states = await inspectLegacyCandleBuildMigration(store, plan)
  check(states.every(state => state.status === 'completed'), 'incomplete')
  return { ddlCount, steps: states.map(({ step, status }) => ({ id: step.id, status })) }
}
