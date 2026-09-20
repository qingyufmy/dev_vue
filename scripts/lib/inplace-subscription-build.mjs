import { assertFrozenMigrationPrefix } from './frozen-migration-prefix.mjs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadMigrationPlan, sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadStrategyUpgrade, strategyStore, executeStrategyUpgrade } from './inplace-strategy-upgrade.mjs'
import { orderedSchemaStep, executeOrderedSchema } from './inplace-ordered-schema-upgrade.mjs'

export const subscriptionBuildMapping = Object.freeze({ strategy_subscriptions: 'strategy_subscriptions_v4_build',
  subscription_schedules: 'subscription_schedules_v4_build', subscription_execution_preferences_v4: 'subscription_execution_preferences_v4_build',
  trading_accounts: 'trading_accounts_v4_build' })
export const subscriptionBuildNames = Object.freeze(Object.values(subscriptionBuildMapping).slice(0, 3))

export function subscriptionBuildDefinition(ddl) {
  return ddl.replace(/`([a-z][a-z0-9_]*)`/g, (match, name) => subscriptionBuildMapping[name] ? `\`${subscriptionBuildMapping[name]}\`` : match)
    .replace(/CONSTRAINT `([a-z][a-z0-9_]*)`/g, (_match, name) => `CONSTRAINT \`build_sub_${sha256(name).slice(0, 24)}\``)
}

// MySQL sorts renamed FK/CHECK names in SHOW CREATE. Restore only their
// display order; never erase definitions, duplicate names, or unknown constraints.
export function subscriptionBuildObservedHash(ddl, plannedSql) {
  const names = [...plannedSql.matchAll(/CONSTRAINT `([^`]+)`/g)].map(match => match[1])
  const lines = ddl.split('\n'), constraints = lines.filter(line => /^  CONSTRAINT `/.test(line))
  const actual = constraints.map(line => /^  CONSTRAINT `([^`]+)`/.exec(line)[1])
  if (new Set(actual).size !== actual.length || actual.length !== names.length || actual.some(name => !names.includes(name))) throw new Error('inplace_subscription_constraint_definition_conflict')
  const first = lines.findIndex(line => /^  CONSTRAINT `/.test(line))
  if (first < 0 || lines.slice(first, first + constraints.length).some(line => !/^  CONSTRAINT `/.test(line))) throw new Error('inplace_subscription_constraint_layout_conflict')
  const ordered = names.map((name, i) => constraints[actual.indexOf(name)].replace(/,$/, '') + (i < names.length - 1 ? ',' : ''))
  return tableDefinitionHash([...lines.slice(0, first), ...ordered, ...lines.slice(first + constraints.length)].join('\n'))
}

export async function loadSubscriptionBuild(root) {
  const reference = JSON.parse(await readFile(new URL('docs/migration/dev-vue-subscription-build-reference-20260907.json', root), 'utf8'))
  if (reference.kind !== 'subscription-build-reference/v1' || reference.identity.db !== 'dev_vue_m1_a'
    || reference.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || JSON.stringify(reference.tables.map(row => row.name)) !== JSON.stringify(Object.keys(subscriptionBuildMapping).slice(0, 3))) throw new Error('inplace_subscription_reference_invalid')
  const migrations = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
  assertFrozenMigrationPrefix(reference.migrations, migrations, Object.keys(subscriptionBuildMapping), 'inplace_subscription_reference_history_changed')
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/007_subscription_build_tables.sql', root), 'utf8'))
  if (sql.length !== 3 || sql.some((statement, i) => statement !== subscriptionBuildDefinition(reference.tables[i].ddl))) throw new Error('inplace_subscription_sql_reference_mismatch')
  const strategy = await loadStrategyUpgrade(root)
  const steps = sql.map((statement, i) => orderedSchemaStep({ id: `inplace_006_0${i + 1}_${subscriptionBuildNames[i]}`, table: subscriptionBuildNames[i],
    sql: statement, beforeHash: null, afterHash: tableDefinitionHash(statement) }))
  return { strategy, priorSteps: [...strategy.priorSteps, ...strategy.steps], initialTables: Object.fromEntries(subscriptionBuildNames.map(name => [name, null])), steps }
}

export function subscriptionBuildStore(connection, store, plan) {
  const base = strategyStore(connection, store, plan.strategy)
  return { ...base,
    async assertPrerequisites() {
      await executeStrategyUpgrade({ ...base, history: async () => (await base.history()).filter(row => plan.priorSteps.some(step => step.id === row.id)) }, plan.strategy)
    },
    async tableHash(name) {
      if (!subscriptionBuildNames.includes(name)) return base.tableHash(name)
      const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
      if (!tables.length) return null
      if (tables[0].type !== 'BASE TABLE') throw new Error('inplace_subscription_table_kind')
      const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
      if (triggers.length) throw new Error('inplace_subscription_trigger_conflict')
      const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
      return subscriptionBuildObservedHash(row['Create Table'], plan.steps.find(step => step.table === name).sql)
    },
  }
}

// Caller must hold the same-database upgrade lock and verify the source evidence.
export const executeSubscriptionBuild = (store, plan, options) => executeOrderedSchema(store, plan, options)
