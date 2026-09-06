import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadMigrationPlan, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadUserDefaultsCoordinator } from './inplace-user-defaults.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export const referralTableNames = Object.freeze(['user_referral_accounts'])

export async function loadReferralSchemaCoordinator(root) {
  const reference = JSON.parse(await readFile(new URL('docs/migration/dev-vue-referral-schema-reference-20260907.json', root), 'utf8'))
  if (reference.kind !== 'referral-schema-reference/v1' || reference.identity.db !== 'dev_vue_m1_a'
    || reference.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || reference.tables.length !== referralTableNames.length || new Set(reference.tables.map(t => t.name)).size !== referralTableNames.length
    || reference.tables.some(t => !referralTableNames.includes(t.name) || t.rows !== '0')) throw new Error('inplace_referral_reference_invalid')
  const migrations = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
  if (reference.migrations.length !== migrations.length || migrations.some(m => !reference.migrations.some(r => r.id === m.id
    && r.status === 'completed' && r.checksum_sha256 === m.checksum))) throw new Error('inplace_referral_reference_history_changed')
  const sql = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/010_user_referral_accounts.sql', root), 'utf8'))
  if (sql.length !== referralTableNames.length || sql.some((statement, i) => statement !== reference.tables.find(t => t.name === referralTableNames[i]).ddl)) throw new Error('inplace_referral_sql_reference_mismatch')
  const available = new Set(['users'])
  const added = sql.map((statement, index) => {
    const table = referralTableNames[index]
    for (const match of statement.matchAll(/REFERENCES `([^`]+)`/g)) {
      if (match[1] !== table && !available.has(match[1])) throw new Error('inplace_referral_dependency_order')
    }
    available.add(table)
    return orderedSchemaStep({ id: `inplace_009_${String(index + 1).padStart(2, '0')}_${table}`, table,
      sql: statement, beforeHash: null, afterHash: tableDefinitionHash(statement) })
  })
  const prior = await loadUserDefaultsCoordinator(root)
  return { steps: [...prior.steps, ...added], transitions: [...prior.transitions,
    ...added.map(step => ({ step, key: step.table, before: null, after: step.afterHash }))],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!referralTableNames.includes(name)) return base.tableHash(name)
        const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        if (!tables.length) return null
        if (tables.length !== 1 || tables[0].type !== 'BASE TABLE') throw new Error('inplace_referral_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
        if (triggers.length) throw new Error('inplace_referral_trigger_conflict')
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
