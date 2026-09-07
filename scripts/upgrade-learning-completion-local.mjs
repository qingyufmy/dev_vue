import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { executeLearningCompletionUpgrade } from './lib/execute-learning-completion-upgrade.mjs'
import { learningCompletionProbeGrant } from './lib/learning-completion-probe-grant.mjs'

const root = new URL('../', import.meta.url)
let connection, receipt, grant, host, report
try {
  const [mode, destination, sshHost] = process.argv.slice(2)
  if (mode === '--help' && process.argv.length === 3) {
    console.log('node scripts/upgrade-learning-completion-local.mjs --rehearse <absolute-receipt.json> <ssh-alias>')
    console.log('node scripts/upgrade-learning-completion-local.mjs --check <absolute-receipt.json>')
    console.log('node scripts/upgrade-learning-completion-local.mjs --apply <absolute-receipt.json>')
  } else {
    if (!['--rehearse', '--check', '--apply'].includes(mode) || !isAbsolute(destination)
      || process.argv.length !== (mode === '--rehearse' ? 5 : 4)) throw Error('learning_completion_upgrade_arguments')
    receipt = await open(destination, 'wx', 0o600)
    const env = await loadSettingsMigrationEnvironment(root)
    if (env.MYSQL_DATABASE !== 'dev_vue' || env.MYSQL_USER !== 'dev_vue') throw Error('learning_completion_upgrade_environment')
    if (mode === '--rehearse') { host = sshHost; grant = learningCompletionProbeGrant(host, 'grant') }
    const database = mode === '--rehearse' ? 'dev_vue_m1_source_20260907_02' : 'dev_vue'
    connection = await mysql.createConnection({ ...settingsMigrationConnectionOptions(env), database })
    report = await executeLearningCompletionUpgrade(connection, { database, apply: mode !== '--check', injectAfterDdl: mode === '--rehearse' })
  }
} catch (error) {
  report = { verified: false, code: /^(learning_completion|inplace)_[a-z_]+$/.test(error.message) ? error.message : 'learning_completion_upgrade_failed', schemaConflicts: error.schemaConflicts }
  process.exitCode = 1
} finally {
  await connection?.end()
  if (grant) {
    try { report.grantsRestored = learningCompletionProbeGrant(host, 'restore', grant.priorGrantsSha256).status === 'restored' }
    catch { report.grantsRestored = false; process.exitCode = 1 }
  }
  if (receipt) { await receipt.writeFile(JSON.stringify(report, null, 2) + '\n'); await receipt.sync(); await receipt.close() }
  if (report) console.log(JSON.stringify({ code: report.code, database: report.identity?.db, schemaSteps: report.schemaSteps,
    ddlCount: report.ddlCount, grantsRestored: report.grantsRestored, originalAndMigratedRowsVerified: report.originalAndMigratedRowsVerified }))
}
