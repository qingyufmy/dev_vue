import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements, validateMigrationStatement } from './v4-migration-plan.mjs'
import { inplaceColumnSteps, validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { executeFoundationSteps, tableDefinitionHash, withTableInspection } from './inplace-foundation-upgrade.mjs'

export const accountBuildNames = Object.freeze(['trading_accounts_v4_build', 'trading_account_ownership_intervals_v4_build',
  'trading_account_ownerships_v4_build', 'user_trading_account_settings_v4_build'])
export function accountBuildDefinition(reference) {
  return reference.replace(/`([a-z][a-z0-9_]*)`/g, (match, name) => accountBuildNames.includes(`${name}_v4_build`) ? `\`${name}_v4_build\`` : match)
}

export async function loadAccountBuildSteps(root) {
  const reference = JSON.parse(await readFile(new URL('docs/migration/dev-vue-account-build-reference-20260906.json', root), 'utf8'))
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/004_account_build_tables.sql', root), 'utf8'))
  if (statements.length !== accountBuildNames.length || reference.tables.length !== statements.length) throw new Error('inplace_account_build_plan_size')
  return statements.map((sql, index) => {
    const table = accountBuildNames[index]
    const blueprint = reference.tables[index]
    if (`${blueprint.name}_v4_build` !== table || sql !== accountBuildDefinition(blueprint.ddl)) throw new Error('inplace_account_build_reference_mismatch')
    validateMigrationStatement(sql, 'inplace_account_build')
    const expectedHash = tableDefinitionHash(sql)
    return { id: `inplace_003_${String(index + 1).padStart(2, '0')}_${table}`, table, sql, expectedHash,
      checksum: sha256(JSON.stringify({ sql, expectedHash, referenceHash: sha256(blueprint.ddl) })) }
  })
}

export async function executeAccountBuild(store, foundation, build, options = {}) {
  const history = validateColumnHistory(await store.history(), [...inplaceColumnSteps, ...foundation, ...build])
  if (!foundation.every(step => history.get(step.id)?.status === 'completed')) throw new Error('inplace_foundation_required')
  return executeFoundationSteps(store, [...foundation, ...build], options)
}

export function inspectAccountBuild(connection, store) {
  const base = withTableInspection(connection, store)
  return { ...base, async tableHash(name) {
    if (!accountBuildNames.includes(name)) return base.tableHash(name)
    const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
    if (!tables.length) return null
    if (tables[0].type !== 'BASE TABLE') throw new Error('inplace_table_kind_conflict')
    const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
    if (triggers.length) throw new Error('inplace_table_trigger_conflict')
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    return tableDefinitionHash(row['Create Table'])
  } }
}
