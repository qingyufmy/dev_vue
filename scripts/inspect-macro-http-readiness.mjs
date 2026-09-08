import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const tables = ['macro_data_sources', 'macro_series', 'macro_observations', 'macro_ingestion_runs',
  'macro_feature_sets', 'macro_model_versions', 'macro_research_snapshots', 'macro_snapshot_observations',
  'economic_calendar_events', 'economic_calendar_event_revisions']
const output = await open(destination, 'wx', 0o600)
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.31.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
try {
  connection = await pool.getConnection()
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  const [columns] = await connection.execute(`SELECT TABLE_NAME tableName,COLUMN_NAME columnName,COLUMN_TYPE columnType,
    IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME IN (${tables.map(() => '?').join(',')}) ORDER BY TABLE_NAME,ORDINAL_POSITION`, tables)
  const missing = tables.filter(table => !columns.some(column => column.tableName === table))
  const counts = []
  for (const table of tables.filter(table => !missing.includes(table))) {
    // Identifiers originate exclusively from the fixed table list above.
    const [[row]] = await connection.query(`SELECT COUNT(*) count FROM \`${table}\``)
    counts.push({ table, count: String(row.count) })
  }
  const groups = {}
  if (!missing.includes('macro_data_sources')) {
    const [rows] = await connection.query(`SELECT status,display_allowed displayAllowed,derived_data_allowed derivedAllowed,
      CASE WHEN license_expires_at_utc IS NULL THEN 'no_expiry' WHEN license_expires_at_utc>UTC_TIMESTAMP(3) THEN 'current' ELSE 'expired' END licenseState,
      COUNT(*) count FROM macro_data_sources GROUP BY status,display_allowed,derived_data_allowed,licenseState`)
    groups.sources = rows
  }
  if (!missing.includes('macro_research_snapshots')) {
    const [rows] = await connection.query(`SELECT schema_version schemaVersion,owner_scope ownerScope,publication_status publicationStatus,
      freshness_status freshness,health_status health,COUNT(*) count FROM macro_research_snapshots
      GROUP BY schema_version,owner_scope,publication_status,freshness_status,health_status`)
    groups.snapshots = rows
  }
  await connection.rollback()
  await output.writeFile(JSON.stringify({ kind: 'macro-http-readiness/v1', observedAt: new Date().toISOString(), identity,
    missing, columns, counts, groups,
    scope: 'Read-only schema/aggregate evidence. No provider names, credentials, payloads, user identities or API requests. Table presence does not prove compatible contents, publication readiness or a functioning reader.' }, null, 2) + '\n')
  console.log(JSON.stringify({ missing, counts, groups }))
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  await pool.end(); await output.sync(); await output.close()
}
