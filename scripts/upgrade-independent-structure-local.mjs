import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { learningCompletionProbeGrant } from './lib/learning-completion-probe-grant.mjs'
import { executeIndependentStructureUpgrade } from './lib/execute-independent-structure-upgrade.mjs'

const root = new URL('../', import.meta.url)
let connection, output, grant, host, report
try {
  const [mode, destination, sshHost] = process.argv.slice(2)
  if (!['--check', '--apply', '--rehearse'].includes(mode) || !isAbsolute(destination)
    || process.argv.length !== (mode === '--rehearse' ? 5 : 4)) throw Error('independent_structure_arguments')
  output = await open(destination, 'wx', 0o600)
  const env = await loadSettingsMigrationEnvironment(root)
  if (env.MYSQL_DATABASE !== 'dev_vue' || env.MYSQL_USER !== 'dev_vue') throw Error('independent_structure_environment')
  const database = mode === '--rehearse' ? 'dev_vue_m1_source_20260907_02' : 'dev_vue'
  if (mode === '--rehearse') { host = sshHost; grant = learningCompletionProbeGrant(host, 'grant') }
  connection = await mysql.createConnection({ ...settingsMigrationConnectionOptions(env), database })
  report = await executeIndependentStructureUpgrade(connection, { database, apply: mode !== '--check', injectAfterDdl: mode === '--rehearse' })
} catch (error) {
  report = { verified: false, code: /^(independent_structure|inplace)_[a-z_]+$/.test(error.message) ? error.message : 'independent_structure_upgrade_failed' }
  process.exitCode = 1
} finally {
  await connection?.end()
  if (grant) {
    try { report.grantsRestored = learningCompletionProbeGrant(host, 'restore', grant.priorGrantsSha256).status === 'restored' }
    catch { report.grantsRestored = false; process.exitCode = 1 }
  }
  if (output) { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close() }
  if (report) console.log(JSON.stringify({ code: report.code, database: report.identity?.db, schemaSteps: report.schemaSteps,
    ddlCount: report.ddlCount, grantsRestored: report.grantsRestored, protectedDataSchemaCountersUnchanged: report.protectedDataSchemaCountersUnchanged }))
}
