import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

/** Store proves identity, held upgrade lock, reviewed DDL fingerprint and protected data on every inspection. */
export async function inspectSingleTableUpgrade(store, plan, prefix) {
  const check = (value, code) => { if (!value) throw Error(`${prefix}_${code}`) }
  await store.verifyPlan(plan)
  check(/^[a-f0-9]{64}$/.test(plan.step.afterHash ?? ''), 'reference_hash_missing')
  const history = await store.history(), entries = validateColumnHistory(history, plan.steps)
  check(plan.prior.steps.every(step => entries.get(step.id)?.status === 'completed'), 'prior_incomplete')
  const priorIds = new Set(plan.prior.steps.map(step => step.id))
  await store.verifyPrior(history.filter(row => priorIds.has(row.id)))
  await store.verifyProtected()
  const entry = entries.get(plan.step.id), table = await store.tableState()
  if (table !== null) check(table.hash === plan.step.afterHash && Number.isSafeInteger(table.rows) && table.rows >= 0, 'table_conflict')
  if (entry?.status === 'completed') { check(table !== null, 'completed_table_missing'); return { status: 'completed' } }
  if (table !== null) {
    check(entry?.status === 'started' && table.rows === 0, 'unrecorded_or_populated_table')
    return { status: 'reconcile' }
  }
  return { status: 'pending', recorded: Boolean(entry) }
}

export async function coordinateSingleTableUpgrade(store, plan, prefix, { apply = false } = {}) {
  const inspect = () => inspectSingleTableUpgrade(store, plan, prefix)
  let state = await inspect(), ddlCount = 0
  if (!apply || state.status === 'completed') return { status: state.status, ddlCount }
  if (state.status === 'pending') {
    if (!state.recorded) {
      try { await store.begin(plan.step) } catch (cause) { throw Error(`${prefix}_begin_unknown`, { cause }) }
    }
    state = await inspect()
    if (state.status !== 'pending' || !state.recorded) throw Error(`${prefix}_precondition_changed`)
    try { await store.execute(plan.step); ddlCount++ } catch (cause) { throw Error(`${prefix}_ddl_unknown`, { cause }) }
  }
  state = await inspect()
  if (state.status !== 'reconcile') throw Error(`${prefix}_postcondition_failed`)
  try { await store.complete(plan.step) } catch (cause) { throw Error(`${prefix}_complete_unknown`, { cause }) }
  state = await inspect()
  if (state.status !== 'completed') throw Error(`${prefix}_completion_not_recorded`)
  return { status: 'completed', ddlCount }
}
