import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
let connection
try {
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a' })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  if (identity.db !== 'dev_vue_m1_a' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('identity')
  const tables = []
  for (const name of ['strategy_subscriptions', 'subscription_schedules', 'subscription_execution_preferences_v4']) {
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    tables.push({ name, ddl: row['Create Table'] })
  }
  const [migrations] = await connection.query('SELECT id,checksum_sha256,status FROM schema_migrations ORDER BY id')
  if (migrations.length !== 28 || migrations.some(row => row.status !== 'completed')) throw new Error('history')
  console.log(JSON.stringify({ kind: 'subscription-build-reference/v1', observedAt: new Date().toISOString(), identity, tables, migrations }))
} catch {
  console.error('{"status":"failed","code":"subscription_build_reference_failed"}')
  process.exitCode = 1
} finally { await connection?.end() }
