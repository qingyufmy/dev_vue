import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
const sha = value => createHash('sha256').update(value).digest('hex')
let connection
let queryName = 'setup', phase = 'connect'
try {
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))

  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', timezone: 'Z' })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  if (identity.db !== 'dev_vue_m1_a' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('identity')
  await connection.beginTransaction()
  const results = []
  for (const name of ['macro_data_sources','macro_feature_sets','macro_research_snapshots','economic_calendar_events','macro_model_versions','macro_series','macro_ingestion_runs','macro_pipeline_jobs','economic_calendar_event_revisions','macro_observations','macro_snapshot_observations']) {
    queryName = name
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    const [[count]] = await connection.query(`SELECT COUNT(*) n FROM \`${name}\``)
    if (Number(count.n) !== 0) throw new Error('reference_not_empty')
    results.push({ name, ddl: row['Create Table'], rows: String(count.n) })
  }
  const [migrations] = await connection.query('SELECT id,checksum_sha256,status FROM schema_migrations ORDER BY id')
  await connection.rollback()
  console.log(JSON.stringify({ kind: 'macro-schema-reference/v1', observedAt: new Date().toISOString(), identity,
    tables: results, migrations, businessWritesPerformed: false, fixtureBehaviorVerified: false }))
} catch (error) {
  if (connection) await connection.rollback().catch(() => {})
  console.error(JSON.stringify({ status: 'failed', queryName, phase, code: error.code ?? 'window_sql_verification_failed' }))
  process.exitCode = 1
} finally { await connection?.end() }
