import { accountRootRenames } from './account-root-promotion.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

const physicalNames = new Map(accountRootRenames)
const historicalNames = new Map(accountRootRenames.map(([before, after]) => [after, before]))
const physical = name => physicalNames.get(name) ?? name
const historical = name => historicalNames.get(name) ?? name
const normalize = sql => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : ''
const blocked = () => { throw Error('account_historical_query_not_allowed') }
const tableQuery = 'SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?'
const triggerQuery = 'SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?'
const columnQuery = 'SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collation,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?'

// Restore only table positions in SHOW CREATE, never column/constraint names,
// string literals or comments. The old verifier still checks every definition.
export function historicalAccountDefinition(logicalName, ddl) {
  if (typeof ddl !== 'string') throw Error('account_historical_definition_missing')
  const header = /^CREATE TABLE `([a-z][a-z0-9_]*)` \(/.exec(ddl)
  if (header?.[1] !== physical(logicalName)) throw Error('account_historical_definition_table')
  return ddl.replace(/^CREATE TABLE `[a-z][a-z0-9_]*`/, `CREATE TABLE \`${logicalName}\``)
    .replace(/^(  CONSTRAINT `[^`]+` FOREIGN KEY \([^)]+\) REFERENCES )`([a-z][a-z0-9_]*)`/gm,
      (_full, prefix, name) => `${prefix}\`${historical(name)}\``)
}

export function promotedAccountMetadataConnection(connection) {
  return Object.freeze({
    async query(sql) {
      const text = normalize(sql)
      if (text === 'SELECT DATABASE() db') return connection.query(text)
      const match = /^SHOW CREATE TABLE (?:`([a-z][a-z0-9_]*)`|([a-z][a-z0-9_]*))$/.exec(text)
      if (!match) return blocked()
      const logicalName = match[1] ?? match[2]
      const [rows, fields] = await connection.query(`SHOW CREATE TABLE \`${physical(logicalName)}\``)
      if (rows.length !== 1) throw Error('account_historical_definition_missing')
      return [[{ ...rows[0], Table: logicalName, 'Create Table': historicalAccountDefinition(logicalName, rows[0]['Create Table']) }], fields]
    },
    async execute(sql, values) {
      const text = normalize(sql)
      const count = text === columnQuery ? 2 : [tableQuery, triggerQuery].includes(text) ? 1 : 0
      if (!count || !Array.isArray(values) || values.length !== count
        || values.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value))) return blocked()
      return connection.execute(text, [physical(values[0]), ...values.slice(1)])
    },
  })
}

// The future promotion coordinator must first validate its complete registry,
// then supply only the exact prior registry's rows. No unknown rows are filtered
// here. This projection cannot execute migrations or complete journal entries.
export async function promotedAccountHistoricalStore(connection, priorPlan, history) {
  const validated = validateColumnHistory(history, priorPlan.steps)
  if (!priorPlan.steps.every(step => validated.get(step.id)?.status === 'completed')) throw Error('account_historical_registry_incomplete')
  const [tables] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')
  const byName = new Map(tables.map(table => [table.name, table.kind]))
  const destinations = new Set(physicalNames.values())
  if ([...destinations].some(name => byName.get(name) !== 'BASE TABLE')
    || [...physicalNames.keys()].some(name => !destinations.has(name) && byName.has(name))) throw Error('account_historical_layout_conflict')
  const base = priorPlan.store(promotedAccountMetadataConnection(connection))
  return { ...base, history: async () => history.map(row => ({ ...row })), begin: blocked, execute: blocked, complete: blocked }
}
