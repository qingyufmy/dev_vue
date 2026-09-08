import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { learningCompletionProbeGrant } from './lib/learning-completion-probe-grant.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { independentTables, independentStructureSource } from './lib/independent-structure-plan.mjs'
import { independentProtectedSnapshot } from './lib/independent-structure-snapshot.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'

const root = new URL('../', import.meta.url), database = 'dev_vue_m1_source_20260907_02'
let output, connection, grant, host, report
try {
  const [mode, destination, sshHost] = process.argv.slice(2)
  if (mode !== '--apply' || process.argv.length !== 5 || !isAbsolute(destination)) throw Error('independent_structure_arguments')
  output = await open(destination, 'wx', 0o600)
  const env = await loadSettingsMigrationEnvironment(root)
  if (env.MYSQL_DATABASE !== 'dev_vue' || env.MYSQL_USER !== 'dev_vue') throw Error('independent_structure_environment')
  host = sshHost; grant = learningCompletionProbeGrant(host, 'grant')
  connection = await mysql.createConnection({ ...settingsMigrationConnectionOptions(env), database })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  if (identity.db !== database || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw Error('independent_structure_identity')
  report = await withInplaceUpgradeLock(connection, database, async () => {
    const source = await independentStructureSource(root)
    const [existing] = await connection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')
    if (existing.some(row => independentTables.includes(row.name))) throw Error('independent_structure_preexisting')
    const before = await independentProtectedSnapshot(connection), steps = [], created = []
    let cycle = false
    try {
      for (const row of source) {
        const beforeDefinition = row.sql.startsWith('ALTER') ? (await connection.query(`SHOW CREATE TABLE \`${row.table}\``))[0][0]['Create Table'] : null
        await connection.query(row.sql)
        if (row.sql.startsWith('CREATE')) created.push(row.table)
        else cycle = true
        const [[definition]] = await connection.query(`SHOW CREATE TABLE \`${row.table}\``)
        steps.push({ ...row, beforeDefinition, definition: definition['Create Table'],
          beforeHash: beforeDefinition === null ? null : tableDefinitionHash(beforeDefinition), afterHash: tableDefinitionHash(definition['Create Table']) })
      }
    } finally {
      // All tables were absent before this probe. Never disable foreign keys or delete rows.
      for (const name of created) {
        const [[count]] = await connection.query(`SELECT COUNT(*) total FROM \`${name}\``)
        if (Number(count.total) !== 0) throw Error('independent_structure_cleanup_nonempty')
      }
      if (cycle) await connection.query('ALTER TABLE strategy_memory_libraries_v4 DROP FOREIGN KEY fk_strategy_memory_current_revision')
      for (const name of [...created].reverse()) await connection.query(`DROP TABLE \`${name}\``)
    }
    const after = await independentProtectedSnapshot(connection)
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('independent_structure_protected_changed')
    return { kind: 'independent-structure-reference/v1', identity, steps, verified: steps.length === 11,
      protectedTables: before.rows.length, protectedRows: before.rows, originalSchemaDataCountersUnchanged: true,
      referenceTablesRemoved: true, currentDevVueWritten: false, seedsApplied: false }
  })
} catch (error) {
  report = { verified: false, code: /^independent_structure_[a-z_]+$/.test(error.message) ? error.message : 'independent_structure_probe_failed', mysqlCode: error.code }
  process.exitCode = 1
} finally {
  await connection?.end()
  if (grant) {
    try { report.grantsRestored = learningCompletionProbeGrant(host, 'restore', grant.priorGrantsSha256).status === 'restored' }
    catch { report.grantsRestored = false; process.exitCode = 1 }
  }
  if (output) { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close() }
  console.log(JSON.stringify({ verified: report?.verified, steps: report?.steps?.length, code: report?.code, grantsRestored: report?.grantsRestored }))
}
