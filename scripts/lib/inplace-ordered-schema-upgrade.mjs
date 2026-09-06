import { sha256, splitSqlStatements, validateMigrationStatement } from './v4-migration-plan.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

const identifier = /^[a-z][a-z0-9_]*$/
const fingerprint = value => value === null || /^[a-f0-9]{64}$/.test(value)

// CREATE and later ADD CONSTRAINT can affect the same table. Each transition
// binds both SHOW CREATE fingerprints; completed earlier steps must not be
// compared with their obsolete intermediate table definition.
export function orderedSchemaStep({ id, table, sql, beforeHash, afterHash }) {
  if (!identifier.test(id) || !identifier.test(table) || !fingerprint(beforeHash)
    || !fingerprint(afterHash) || afterHash === null || beforeHash === afterHash) throw new Error('inplace_transition_invalid')
  const statements = splitSqlStatements(sql)
  if (statements.length !== 1 || statements[0] !== sql) throw new Error('inplace_transition_statement_invalid')
  validateMigrationStatement(sql, id)
  const create = new RegExp('^CREATE TABLE `' + table + '` \\(').test(sql)
  const key = '`?[a-z][a-z0-9_]*`?'
  const columns = '\\(\\s*' + key + '(?:\\s*,\\s*' + key + ')*\\s*\\)'
  const constraint = new RegExp('^ALTER TABLE `' + table + '`\\s+ADD CONSTRAINT ' + key
    + '\\s+FOREIGN KEY\\s*' + columns + '\\s+REFERENCES\\s+' + key + '\\s*' + columns
    + '(?:\\s+ON (?:DELETE|UPDATE) (?:RESTRICT|NO ACTION))*$').test(sql)
  if (!(create && beforeHash === null) && !(constraint && beforeHash !== null)) throw new Error('inplace_transition_operation_not_allowed')
  if (constraint && /\b(?:DROP|MODIFY|CHANGE|RENAME|DISABLE|ENABLE)\b/i.test(sql)) throw new Error('inplace_transition_operation_not_allowed')
  const value = { id, table, sql, beforeHash, afterHash }
  return Object.freeze({ ...value, checksum: sha256(JSON.stringify(value)) })
}

// Caller holds the existing exclusive MySQL upgrade lock. Prerequisites must
// verify earlier migrations, source schema and the reviewed parent definitions.
// No foreign_key_checks override, table replacement or business writes.
export async function executeOrderedSchema(store, { priorSteps, initialTables, steps }, { apply = false } = {}) {
  if (!Array.isArray(priorSteps) || !steps.length || !Object.keys(initialTables).length
    || Object.entries(initialTables).some(([name, hash]) => !identifier.test(name) || !fingerprint(hash))) throw new Error('inplace_transition_plan_invalid')
  const planned = { ...initialTables }
  const registry = [...priorSteps, ...steps]
  if (new Set(registry.map(step => step.id)).size !== registry.length) throw new Error('inplace_transition_duplicate_step')
  for (const step of steps) {
    if (orderedSchemaStep(step).checksum !== step.checksum || planned[step.table] !== step.beforeHash) throw new Error('inplace_transition_chain_invalid')
    planned[step.table] = step.afterHash
  }
  const history = validateColumnHistory(await store.history(), registry)
  if (!priorSteps.every(step => history.get(step.id)?.status === 'completed')) throw new Error('inplace_transition_prerequisite_missing')
  await store.assertPrerequisites()
  const expected = { ...initialTables }
  let pending = null
  for (const step of steps) {
    const row = history.get(step.id)
    if (row?.status === 'completed') expected[step.table] = step.afterHash
    if (row?.status === 'started') pending = step
  }
  let reconcile = false
  // Validate every tracked table before writing even the first journal row.
  for (const [table, hash] of Object.entries(expected)) {
    const actual = await store.tableHash(table)
    if (pending?.table === table && actual === pending.afterHash) { reconcile = true; expected[table] = actual }
    else if (actual !== hash) throw new Error('inplace_transition_schema_conflict')
  }
  const result = []
  for (const step of steps) {
    const row = history.get(step.id)
    if (row?.status === 'completed') { result.push({ id: step.id, status: 'completed' }); continue }
    const alreadyApplied = pending?.id === step.id && reconcile
    if (!apply) { result.push({ id: step.id, status: alreadyApplied ? 'reconcile' : 'pending' }); continue }
    if (!row) await store.begin(step)
    if (!alreadyApplied) {
      if (await store.tableHash(step.table) !== step.beforeHash) throw new Error('inplace_transition_precondition_failed')
      await store.execute(step.sql)
    }
    if (await store.tableHash(step.table) !== step.afterHash) throw new Error('inplace_transition_postcondition_failed')
    await store.complete(step)
    result.push({ id: step.id, status: alreadyApplied ? 'reconciled' : 'applied' })
  }
  return { apply, steps: result }
}
