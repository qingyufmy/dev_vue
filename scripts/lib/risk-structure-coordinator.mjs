import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

const check = (value, code) => { if (!value) throw Error('risk_structure_' + code) }

// The store owns an exclusive same-connection lock, live identity, frozen inputs,
// reference DDL hashes, restore proof and the complete 166-step validation.
export async function inspectRiskStructure(store, plan) {
  check(plan.prior.steps.length === 166 && plan.additions.length === 8, 'plan_shape')
  const definitions = await store.verifyPlan(plan)
  check(Array.isArray(definitions) && definitions.length === plan.additions.length, 'definitions')
  const chain = new Map()
  for (const [index, step] of plan.additions.entries()) {
    const definition = definitions[index]
    check(definition?.stepId === step.id && definition.beforeHash === (chain.get(step.table) ?? null)
      && /^[a-f0-9]{64}$/.test(definition.afterHash) && definition.afterHash !== definition.beforeHash, 'definition_chain')
    chain.set(step.table, definition.afterHash)
  }
  const history = await store.history(), entries = validateColumnHistory(history, plan.steps)
  check(plan.prior.steps.every(step => entries.get(step.id)?.status === 'completed'), 'prior_incomplete')
  const states = new Map([...chain.keys()].map(table => [table, null]))
  let next = null
  for (const [index, step] of plan.additions.entries()) {
    const entry = entries.get(step.id)
    if (entry?.status === 'completed') states.set(step.table, definitions[index].afterHash)
    else if (!next) next = { step, definition: definitions[index], recorded: Boolean(entry), status: 'pending' }
  }
  const actual = new Map()
  for (const [table, expected] of states) {
    const state = await store.tableState(table)
    actual.set(table, state)
    if (state !== null) {
      check(/^[a-f0-9]{64}$/.test(state.hash) && Number.isSafeInteger(state.rows) && state.rows >= 0, 'table_state_invalid')
      // No business writes before the entire structure batch is complete.
      if (next) check(state.rows === 0, 'premature_rows')
    }
    if (next?.recorded && next.step.table === table && state?.hash === next.definition.afterHash) next.status = 'reconcile'
    else check((state?.hash ?? null) === expected, 'table_conflict')
  }
  const snapshot = await store.snapshot()
  for (const [table, state] of actual) {
    const rows = snapshot.filter(row => row.name === table)
    check(rows.length === (state === null ? 0 : 1) && (state === null || rows[0].rows === state.rows), 'snapshot_disagreement')
  }
  const priorSnapshot = snapshot.filter(row => !states.has(row.name))
  await store.verifyProtected(priorSnapshot, next === null)
  const priorIds = new Set(plan.prior.steps.map(step => step.id))
  const prior = await store.verifyPrior(history.filter(row => priorIds.has(row.id)), priorSnapshot)
  check(prior.status === 'completed', 'prior_not_completed')
  return next ?? { status: 'completed' }
}

export async function coordinateRiskStructure(store, plan, { apply = false } = {}) {
  let state = await inspectRiskStructure(store, plan)
  let ddlCount = 0
  if (!apply) return { status: state.status, ddlCount }
  while (state.status !== 'completed') {
    const step = state.step
    if (state.status === 'pending') {
      if (!state.recorded) {
        try { await store.begin(step) }
        catch (cause) { throw Error('risk_structure_begin_unknown', { cause }) }
      }
      state = await inspectRiskStructure(store, plan)
      check(state.status === 'pending' && state.recorded && state.step.id === step.id, 'precondition_changed')
      try { await store.execute(step); ddlCount++ }
      catch (cause) { throw Error('risk_structure_ddl_unknown', { cause }) }
    }
    state = await inspectRiskStructure(store, plan)
    check(state.status === 'reconcile' && state.step.id === step.id, 'postcondition_failed')
    try { await store.complete(step) }
    catch (cause) { throw Error('risk_structure_complete_unknown', { cause }) }
    state = await inspectRiskStructure(store, plan)
    check(state.status === 'completed' || state.step.id !== step.id, 'completion_not_recorded')
  }
  return { status: 'completed', ddlCount }
}
