import { loadSubscriptionBuild, subscriptionBuildStore } from './inplace-subscription-build.mjs'
import { columnMatches, validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { mysqlColumnStore } from './mysql-inplace-column-store.mjs'

// Load immutable, reviewed SQL through the existing reference/checksum loaders.
// This coordinates structure only; it does not declare business migration done.
export async function loadInplaceSchemaCoordinator(root) {
  const subscription = await loadSubscriptionBuild(root)
  const steps = [...subscription.priorSteps, ...subscription.steps]
  const states = new Map()
  const transitions = steps.map(step => {
    const key = step.column ? `${step.table}.${step.column}` : step.table
    const before = step.column ? null : step.beforeHash ?? null
    const after = step.column ? step.expected : step.afterHash ?? step.expectedHash
    if ((states.get(key) ?? null) !== before || after === undefined) throw new Error('inplace_coordinator_chain_invalid')
    states.set(key, after)
    return { step, key, before, after }
  })
  return { steps, transitions, store: connection => subscriptionBuildStore(connection, mysqlColumnStore(connection, true), subscription) }
}

const matches = (step, actual, expected) => step.column && expected !== null ? columnMatches(actual, expected) : actual === expected
const read = (store, step) => step.column ? store.column(step.table, step.column) : store.tableHash(step.table)

// Caller verifies journal, database identity, original schema/data and backup,
// and holds the same-connection upgrade lock throughout this operation.
export async function coordinateInplaceSchema(store, plan, { apply = false } = {}) {
  const history = validateColumnHistory(await store.history(), plan.steps)
  const expected = new Map()
  let pending
  for (const transition of plan.transitions) {
    const { step, key, before, after } = transition
    if (!expected.has(key)) expected.set(key, { step, value: before })
    if (history.get(step.id)?.status === 'completed') expected.set(key, { step, value: after })
    if (history.get(step.id)?.status === 'started') pending = transition
  }
  let reconciled = false
  // Inspect even late-phase objects before the first journal write.
  for (const [key, { step, value }] of expected) {
    const actual = await read(store, step)
    if (pending?.key === key && matches(step, actual, pending.after)) reconciled = true
    else if (!matches(step, actual, value)) throw new Error('inplace_coordinator_schema_conflict')
  }
  const results = []
  for (const { step, before, after } of plan.transitions) {
    const row = history.get(step.id)
    if (row?.status === 'completed') { results.push({ id: step.id, status: 'completed' }); continue }
    const alreadyApplied = pending?.step.id === step.id && reconciled
    if (!apply) { results.push({ id: step.id, status: alreadyApplied ? 'reconcile' : 'pending' }); continue }
    if (!row) await store.begin(step)
    if (!alreadyApplied) {
      if (!matches(step, await read(store, step), before)) throw new Error('inplace_coordinator_precondition_failed')
      await store.execute(step.sql)
    }
    if (!matches(step, await read(store, step), after)) throw new Error('inplace_coordinator_postcondition_failed')
    await store.complete(step)
    results.push({ id: step.id, status: alreadyApplied ? 'reconciled' : 'applied' })
  }
  return { apply, steps: results, structureComplete: results.every(row => ['completed', 'applied', 'reconciled'].includes(row.status)), fullNormalizationComplete: false }
}
