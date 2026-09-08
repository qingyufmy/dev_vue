import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { coordinateTerminalRouteMigration } from './terminal-route-coordinator.mjs'

const check = (condition, code) => { if (!condition) throw Error(`observer_context_${code}`) }

// The adapter holds the same-connection upgrade lock and verifies a durable plan.
// tableState verifies the complete canonical schema, not just table existence.
// verifyProtected checks the frozen prior rows until all four new steps are complete.
export async function inspectObserverContextMigration(store, plan) {
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
  const snapshot = await store.priorStore.rootStore.snapshot()
  // Only exact, separately verified additions may be removed from the old snapshot.
  for (const state of states) {
    const present = snapshot.some(table => table.name === state.step.table)
    check(present === (state.status !== 'pending'), 'snapshot_table_disagreement')
  }
  const priorSnapshot = snapshot.filter(table => !additionNames.has(table.name))
  await store.verifyProtected(priorSnapshot, states.every(state => state.status === 'completed'))
  const prior = await coordinateTerminalRouteMigration({
    ...store.priorStore,
    history: async () => history.filter(row => priorIds.has(row.id)),
    rootStore: { ...store.priorStore.rootStore, snapshot: async () => priorSnapshot },
  }, plan.prior)
  check(prior.steps.every(step => step.status === 'completed'), 'prior_not_completed')
  return states
}

export async function coordinateObserverContextMigration(store, plan, { apply = false } = {}) {
  let states = await inspectObserverContextMigration(store, plan)
  if (!apply) return { ddlCount: 0, steps: states.map(({ step, status }) => ({ id: step.id, status })) }
  let ddlCount = 0
  for (const step of plan.additions) {
    // Fresh complete inspection before every step, including recovery after another process.
    states = await inspectObserverContextMigration(store, plan)
    const state = states.find(item => item.step.id === step.id)
    if (state.status === 'completed') continue
    if (state.status === 'pending') {
      const history = validateColumnHistory(await store.history(), plan.steps)
      if (!history.has(step.id)) {
        try { await store.begin(step) }
        catch { throw Error('observer_context_begin_unknown') }
      }
      const checked = await inspectObserverContextMigration(store, plan)
      check(checked.find(item => item.step.id === step.id)?.status === 'pending', 'precondition_changed')
      try { await store.execute(step); ddlCount++ }
      catch { throw Error('observer_context_ddl_unknown') }
    }
    const after = await inspectObserverContextMigration(store, plan)
    check(after.find(item => item.step.id === step.id)?.status === 'reconcile', 'postcondition_failed')
    try { await store.complete(step) }
    catch { throw Error('observer_context_complete_unknown') }
  }
  states = await inspectObserverContextMigration(store, plan)
  check(states.every(state => state.status === 'completed'), 'incomplete')
  return { ddlCount, steps: states.map(({ step, status }) => ({ id: step.id, status })) }
}
