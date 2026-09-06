import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
const sha = value => createHash('sha256').update(value).digest('hex')
let connection
let queryName = 'setup', phase = 'connect'
try {
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  const bytes = await readFile(new URL('./subscription-window-sql-input-v5-20260907.json', import.meta.url))
  const input = JSON.parse(bytes)
  if (input.kind !== 'subscription-window-selects/v5' || input.queries.length !== 10) throw new Error('input')
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', timezone: 'Z' })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  if (identity.db !== 'dev_vue_m1_a' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('identity')
  await connection.beginTransaction()
  const results = []
  for (const query of input.queries) {
    queryName = query.name
    if (!query.sql.startsWith('SELECT ') || query.sql.includes(';') || sha(query.sql) !== query.sqlSha256) throw new Error('query')
    phase = 'explain'
    const [plan] = await connection.execute(`EXPLAIN ${query.sql}`, query.parameters)
    phase = 'select'
    const [rows] = await connection.execute(query.sql, query.parameters)
    if (rows.length !== 0) throw new Error('unexpected_rows')
    results.push({ name: query.name, sqlSha256: query.sqlSha256, explainRows: plan.length, resultRows: rows.length })
  }
  await connection.rollback()
  console.log(JSON.stringify({ kind: 'subscription-window-sql-validation/v5', observedAt: new Date().toISOString(), identity,
    inputSha256: sha(bytes), results, businessWritesPerformed: false, fixtureBehaviorVerified: false }))
} catch (error) {
  if (connection) await connection.rollback().catch(() => {})
  console.error(JSON.stringify({ status: 'failed', queryName, phase, code: error.code ?? 'window_sql_verification_failed' }))
  process.exitCode = 1
} finally { await connection?.end() }
