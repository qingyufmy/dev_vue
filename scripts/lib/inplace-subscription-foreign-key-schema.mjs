import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { runtimeIndexTransitions, runtimeIndexObservedHash } from './inplace-runtime-index-schema.mjs'
import { loadUsageStrategyCapacityCoordinator } from './inplace-usage-strategy-capacity-schema.mjs'

export const subscriptionForeignKeys = [
  ['strategy_subscriptions', 'trading_account_id', 'trading_accounts', 'fk_strategy_subscriptions_account', false],
  ['strategy_subscriptions', 'user_id', 'users', 'fk_strategy_subscriptions_user', false],
]
export async function subscriptionForeignKeyTransitions(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-subscription-foreign-key-source-20260908.json', root))
  if (sha256(bytes) !== '39b3e50617014f2cb71e59ee5de93ea1760d976379a3b157eeca6c3e325febde') throw Error('subscription_fk_source_hash')
  const source = JSON.parse(bytes), priorIndexes = await runtimeIndexTransitions(root)
  if (source.schemaSteps !== 145 || source.databaseWrites !== 0) throw Error('subscription_fk_source_invalid')
  const definitions = new Map(source.definitions.map(row => [row.name, row.sql]))
  return subscriptionForeignKeys.map(([table, column, parent, name, autoIndex], i) => {
    if (source.relations.find(row => row.table === table && row.column === column && row.parent === parent)?.orphans !== '0') throw Error('subscription_fk_orphans')
    const beforeDefinition = definitions.get(table), lines = beforeDefinition.split('\n')
    const constraint = `  CONSTRAINT \`${name}\` FOREIGN KEY (\`${column}\`) REFERENCES \`${parent}\` (\`id\`)`
    const indexLine = autoIndex ? `  KEY \`${name}\` (\`${column}\`)` : null
    if (lines.some(line => line.includes('`' + name + '`'))) throw Error('subscription_fk_exists')
    if (indexLine) {
      let position = lines.findIndex(line => line.startsWith('  CONSTRAINT '))
      if (position < 0) position = lines.findIndex(line => line.startsWith(') ENGINE='))
      lines[position - 1] = lines[position - 1].replace(/,$/, '') + ','
      lines.splice(position, 0, indexLine + (lines[position].startsWith('  CONSTRAINT ') ? ',' : ''))
    }
    const end = lines.findIndex(line => line.startsWith(') ENGINE='))
    if (end < 1) throw Error('subscription_fk_definition')
    lines[end - 1] = lines[end - 1].replace(/,$/, '') + ','
    lines.splice(end, 0, constraint)
    const afterDefinition = lines.join('\n'); definitions.set(table, afterDefinition)
    const before = runtimeIndexObservedHash(table, beforeDefinition, priorIndexes), after = runtimeIndexObservedHash(table, afterDefinition, priorIndexes)
    const value = { id: `inplace_030_0${i + 1}_${name}`, table, sql: `ALTER TABLE \`${table}\` ADD ${constraint.trim()}`, beforeHash: before, afterHash: after }
    return { step: { ...value, checksum: sha256(JSON.stringify(value)) }, key: table, before, after, beforeDefinition, afterDefinition, addedLines: [indexLine, constraint].filter(Boolean) }
  })
}
export function removeSubscriptionForeignKeyDefinitions(name, ddl, transitions) {
  for (const row of transitions.filter(item => item.step.table === name).toReversed()) for (const descriptor of row.addedLines.toReversed()) {
    const lines = ddl.split('\n'), index = lines.findIndex(line => line.replace(/,$/, '') === descriptor)
    if (index < 0) continue
    if (lines[index + 1]?.startsWith(') ENGINE=')) lines[index - 1] = lines[index - 1].replace(/,$/, '')
    lines.splice(index, 1); ddl = lines.join('\n')
  }
  return ddl
}
export async function loadSubscriptionForeignKeyCoordinator(root) {
  const additions = await subscriptionForeignKeyTransitions(root), priorIndexes = await runtimeIndexTransitions(root)
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/034_subscription_foreign_keys.sql', root), 'utf8'))
  if (JSON.stringify(sql) !== JSON.stringify(additions.map(row => row.step.sql))) throw Error('subscription_fk_sql_drift')
  const prior = await loadUsageStrategyCapacityCoordinator(root)
  return { ...prior, steps: [...prior.steps, ...additions.map(row => row.step)], transitions: [...prior.transitions, ...additions],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!subscriptionForeignKeys.some(row => row[0] === name)) return base.tableHash(name)
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return runtimeIndexObservedHash(name, row['Create Table'], priorIndexes)
      } }
    } }
}
