import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { loadMigrationPlan } from './lib/v4-migration-plan.mjs'
import { loadMigrationCorrections } from './lib/v4-migration-corrections.mjs'
import { runSchemaMigrations } from './lib/v4-schema-migration-runner.mjs'

const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
const connections = []
try {
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  for (let i = 0; i < 2; i++) connections.push(await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true }))
  const [execution, control] = connections
  const [[identity]] = await execution.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  if (identity.db !== 'dev_vue_m1_a' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('preferences_reference_identity')
  const counts = {}
  for (const table of ['strategy_subscriptions', 'terminal_history_deals_v4', 'account_trade_records_v4']) {
    const [[row]] = await execution.query(`SELECT CAST(COUNT(*) AS CHAR) n FROM \`${table}\``)
    if (row.n !== '0') throw new Error('preferences_reference_nonempty')
    counts[table] = row.n
  }
  const rootDirectory = fileURLToPath(new URL('../', import.meta.url))
  const plan = await loadMigrationPlan({ rootDirectory })
  if (plan.length !== 28 || plan.at(-1).id !== '20260907_027_subscription_execution_preferences') throw new Error('preferences_reference_plan')
  const corrections = await loadMigrationCorrections({ rootDirectory }, plan)
  const options = { sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue_m1_a', apply: true, corrections }
  // The existing runner validates the full immutable history and owns the lock.
  const result = await runSchemaMigrations(execution, control, plan, options)
  const repeat = await runSchemaMigrations(execution, control, plan, options)
  const [[definition]] = await execution.query('SHOW CREATE TABLE subscription_execution_preferences_v4')
  const [history] = await control.query('SELECT id,status,completed_statements FROM schema_migrations ORDER BY id')
  console.log(JSON.stringify({ kind: 'preferences-reference-upgrade/v1', observedAt: new Date().toISOString(), identity, counts, result, repeat,
    ddl: definition['Create Table'], history, sourceWritesPerformed: false }))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? (/^preferences_reference_/.test(error.message) ? error.message : 'preferences_reference_upgrade_failed') }))
  process.exitCode = 1
} finally { await Promise.allSettled(connections.map(connection => connection.end())) }
