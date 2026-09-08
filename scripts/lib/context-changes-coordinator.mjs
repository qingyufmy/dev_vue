import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

const check = (value, code) => { if (!value) throw Error('context_changes_' + code) }

// Adapter owns the same-connection upgrade lock, identity, frozen tools, canonical DDL and prior proof.
export async function inspectContextChanges(store, plan) {
  check(plan.prior.steps.length === 164 && plan.additions.length === 1
    && plan.additions[0].table === 'trading_context_changes_v4', 'plan_shape')
  await store.verifyPlan(plan)
  const history = await store.history(), validated = validateColumnHistory(history, plan.steps)
  check(plan.prior.steps.every(step => validated.get(step.id)?.status === 'completed'), 'prior_incomplete')
  const step = plan.additions[0], entry = validated.get(step.id), table = await store.tableState(step)
  if (table !== null) {
    check(table.matches === true && Number.isSafeInteger(table.rows) && table.rows >= 0, 'table_conflict')
    check(Boolean(entry), 'unrecorded_table')
    if (entry.status !== 'completed') check(table.rows === 0, 'uncompleted_table_has_rows')
  }
  if (entry?.status === 'completed') check(table !== null, 'completed_table_missing')
  const status = entry?.status === 'completed' ? 'completed' : table ? 'reconcile' : 'pending'
  const snapshot = await store.snapshot()
  check(snapshot.filter(row => row.name === step.table).length === (table ? 1 : 0), 'snapshot_table_disagreement')
  const priorSnapshot = snapshot.filter(row => row.name !== step.table)
  await store.verifyProtected(priorSnapshot, status === 'completed')
  const priorIds = new Set(plan.prior.steps.map(row => row.id))
  // The implementation must run the full 164-step coordinator, including its nested historical checks.
  const prior = await store.verifyPrior(history.filter(row => priorIds.has(row.id)), priorSnapshot)
  check(prior.status === 'completed', 'prior_not_completed')
  return { step, status, recorded: Boolean(entry) }
}

export async function coordinateContextChanges(store, plan, { apply = false } = {}) {
  let state = await inspectContextChanges(store, plan)
  if (!apply || state.status === 'completed') return { status: state.status, ddlCount: 0 }
  let ddlCount = 0
  if (state.status === 'pending') {
    if (!state.recorded) {
      try { await store.begin(state.step) }
      catch (cause) { throw Error('context_changes_begin_unknown', { cause }) }
    }
    state = await inspectContextChanges(store, plan)
    check(state.status === 'pending' && state.recorded, 'precondition_changed')
    try { await store.execute(state.step); ddlCount++ }
    catch (cause) { throw Error('context_changes_ddl_unknown', { cause }) }
  }
  state = await inspectContextChanges(store, plan)
  check(state.status === 'reconcile', 'postcondition_failed')
  try { await store.complete(state.step) }
  catch (cause) { throw Error('context_changes_complete_unknown', { cause }) }
  state = await inspectContextChanges(store, plan)
  check(state.status === 'completed', 'incomplete')
  return { status: 'completed', ddlCount }
}
