import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { MysqlMacroSeriesReader } from '../server/dist-v4/modules/market/infrastructure/mysql-macro-series-reader.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
const checks = [], driverErrors = []
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.timezone, '+00:00')
  const reader = new MysqlMacroSeriesReader({ async execute(...args) {
    try { return await connection.execute(...args) }
    catch (error) { driverErrors.push({ code: error.code, errno: error.errno, sqlState: error.sqlState }); throw error }
  } })
  const query = { code: 'LOCAL_SERIES_PROBE', asOf: '2026-09-09T00:00:00.000Z', accessAt: '2026-09-09T00:00:00.000Z', limit: 101 }
  assert.deepEqual(await reader.list(query), [])
  checks.push('compiled-query-on-permanent-schema')
  // LIKE preserves actual column types and indexes. All fixture writes are session local.
  for (const table of ['macro_data_sources', 'macro_series', 'macro_observations']) {
    await connection.query(`CREATE TEMPORARY TABLE local_probe_${table} LIKE ${table}`)
    await connection.query(`ALTER TABLE local_probe_${table} RENAME TO ${table}`)
  }
  await connection.beginTransaction()
  await connection.query(`INSERT INTO macro_data_sources
    (id,source_key,provider,display_name,status,display_allowed,cache_allowed,retention_allowed,
     license_reviewed_at_utc,created_at_utc,updated_at_utc,rate_limit_json,created_by_user_id)
    VALUES (1,'local-probe','local-probe','Local probe','approved',1,1,1,'2026-01-01','2026-01-01','2026-01-01','{}',1)`)
  await connection.query(`INSERT INTO macro_series
    (id,source_id,series_code,provider_series_key,display_name,series_kind,value_kind,unit,frequency,
     freshness_calendar,freshness_limit_seconds,gold_relation_rule_json,status,created_at_utc,updated_at_utc)
    VALUES (1,1,'LOCAL_SERIES_PROBE','local','Local probe','factor','decimal','percent','daily',
      'local-fixture',259200,'{}','enabled','2026-01-01','2026-01-01')`)
  const add = async (id, observation, available, ingested, value) => connection.execute(`INSERT INTO macro_observations
    (id,series_id,ingestion_run_id,observation_at_utc,available_at_utc,ingested_at_utc,provider_vintage_key,
     availability_confidence,decimal_value,content_sha256,parser_version,created_at_utc)
    VALUES (?,1,'00000000-0000-0000-0000-000000000001',?,?,?,?,'retrieval_only',?,?,'local-v1',?)`,
  [id, observation, available, ingested, String(id), value, String(id).padStart(64, '0'), ingested])
  await add('9007199254740993', '2026-09-07', '2026-09-07', '2026-09-07', '1.0000000001')
  await add('9007199254740994', '2026-09-07', '2026-09-08', '2026-09-08', '2.0000000002')
  await add('9007199254740995', '2026-09-07', '2026-09-08', '2026-09-08 01:00:00', '3.0000000003')
  await add('9007199254740996', '2026-09-07', '2026-09-08', '2026-09-08 01:00:00', '4.1234567890')
  await add('9007199254740997', '2026-09-07', '2026-09-10', '2026-09-08', '5')
  await add('9007199254740998', '2026-09-07', '2026-09-08', '2026-09-10', '6')
  await add('9007199254740999', '2026-09-08', '2026-09-08', '2026-09-08', '7')
  await add('9007199254741000', '2026-09-10', '2026-09-08', '2026-09-08', '8')
  const rows = await reader.list(query)
  assert.equal(rows.length, 2); assert.equal(rows[0].value, '4.1234567890')
  assert.equal(rows[0].observationAt, '2026-09-07T00:00:00.000Z')
  assert.equal(rows[0].availableAt, '2026-09-08T00:00:00.000Z')
  checks.push('one-vintage-per-observation-available-ingested-bigint-order', 'future-observation-available-ingested-excluded', 'decimal-and-utc-preserved')
  assert.equal((await reader.list({ ...query, limit: 1 })).length, 1)
  assert.deepEqual((await reader.list({ ...query, after: rows[0].observationAt })).map(row => row.value), ['7.0000000000'])
  assert.equal((await reader.list({ ...query, from: rows[1].observationAt, to: rows[1].observationAt })).length, 1)
  assert.deepEqual(await reader.list({ ...query, code: 'unknown' }), [])
  checks.push('page-and-inclusive-range', 'unknown-code-empty')
  assert.equal((await reader.list({ ...query, asOf: '2026-09-07T23:00:00.000Z' }))[0].value, '1.0000000001')
  checks.push('historical-cutoff-selects-old-vintage')
  for (const update of ["status='suspended'", 'display_allowed=0', "license_expires_at_utc='2026-09-09 12:00:00'", "retired_at_utc='2026-09-09'", 'license_reviewed_at_utc=NULL']) {
    // Do not violate approved-source CHECK constraints when testing missing review.
    const actualUpdate = update === 'license_reviewed_at_utc=NULL' ? "status='trial',license_reviewed_at_utc=NULL" : update
    await connection.query(`UPDATE macro_data_sources SET ${actualUpdate} WHERE id=1`)
    assert.deepEqual(await reader.list({ ...query, accessAt: '2026-09-10T00:00:00.000Z' }), [])
    await connection.query("UPDATE macro_data_sources SET status='approved',display_allowed=1,license_expires_at_utc=NULL,retired_at_utc=NULL,license_reviewed_at_utc='2026-01-01' WHERE id=1")
  }
  checks.push('current-access-denies-expired-suspended-hidden-retired-unreviewed')
  await connection.rollback()
  const [[remaining]] = await connection.query('SELECT COUNT(*) n FROM macro_observations')
  assert.equal(Number(remaining.n), 0)
  checks.push('temporary-writes-rolled-back')
  await output.writeFile(JSON.stringify({ kind: 'macro-series-reader-mysql/v1', passed: true, observedAt: new Date().toISOString(), identity, checks,
    scope: 'Unmodified compiled query against permanent schema and session-local LIKE tables. No SQL identifier rewriting, permanent writes, providers or service restart. Positive fixtures rolled back; not source calendar or HTTP validation.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, checks, driverErrors, code: 'macro_series_probe_failed',
    failureKind: error instanceof assert.AssertionError ? 'assertion' : 'reader-or-storage', driverCode: error.code }) + '\n')
  console.log(JSON.stringify({ passed: false, checks, driverErrors, code: error.code }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  await pool.end(); await output.sync(); await output.close()
}
