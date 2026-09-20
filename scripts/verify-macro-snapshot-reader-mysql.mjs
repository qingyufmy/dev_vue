import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { sha256Canonical } from '../server/dist-v4/shared/canonical-json.js'
import { projectReadableMacroSnapshot } from '../server/dist-v4/modules/market/application/macro-snapshot-projection.js'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { MysqlPublicMacroSnapshotReader } from '../server/dist-v4/modules/market/infrastructure/mysql-public-macro-snapshot-reader.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
const checks = [], driverErrors = []
let lastQuery, queryPlan
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.timezone, '+00:00')
  const reader = new MysqlPublicMacroSnapshotReader({ async execute(...args) {
    lastQuery = args
    try { return await connection.execute(...args) }
    catch (error) { driverErrors.push({ code: error.code, errno: error.errno, sqlState: error.sqlState }); throw error }
  } })
  const query = { asOf: '2026-09-09T00:00:00.000Z', accessAt: '2026-09-09T00:00:00.000Z', limit: 101 }
  assert.deepEqual(await reader.list(query), [])
  checks.push('compiled-query-on-permanent-schema')
  // LIKE preserves actual column types and indexes. All fixture writes are session local.
  for (const table of ['macro_data_sources', 'macro_series', 'macro_observations', 'macro_research_snapshots', 'macro_snapshot_observations']) {
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
  await connection.query('UPDATE macro_data_sources SET derived_data_allowed=1 WHERE id=1')
  await connection.query(`INSERT INTO macro_observations
    (id,series_id,ingestion_run_id,observation_at_utc,available_at_utc,ingested_at_utc,provider_vintage_key,
    availability_confidence,decimal_value,content_sha256,parser_version,created_at_utc)
    VALUES (1,1,'00000000-0000-0000-0000-000000000001','2026-09-07','2026-09-07','2026-09-07',
    'v1','exact',1.8200000000,REPEAT('a',64),'fixture','2026-09-07')`)
  const payload = { display: { direction: 'uncertain', summary: 'Local fixture', factors: [{ code: 'DFII10', label: 'Rate',
    value: '1.82', unit: '%', observation_at: '2026-09-07T00:00:00.000Z', available_at: '2026-09-07T00:00:00.000Z',
    freshness: 'fresh', gold_relation: 'adverse' }] }, analysis_evidence: { internal: 'must-not-be-returned' } }
  for (const id of ['a', 'b']) {
    await connection.execute(`INSERT INTO macro_research_snapshots
      (id,schema_version,business_date,data_cutoff_at_utc,feature_set_id,owner_scope,revision,publication_status,
      freshness_status,health_status,horizon,observed_at_utc,valid_until_utc,published_at_utc,superseded_at_utc,
      content_sha256,payload_json,created_at_utc)
      VALUES (?,1,'2026-09-08','2026-09-08',1,'platform',9007199254740993,'superseded','fresh','healthy',
      'medium_term','2026-09-08','2026-09-10','2026-09-08 01:00:00','2026-09-08 02:00:00',?,?,'2026-09-08')`,
    [id, sha256Canonical(payload), JSON.stringify(payload)])
    await connection.execute("INSERT INTO macro_snapshot_observations VALUES (?,1,'DFII10','2026-09-08')", [id])
  }
  await connection.query("UPDATE macro_research_snapshots SET publication_status='published',superseded_at_utc=NULL WHERE id='b'")
  const rows = await reader.list(query)
  assert.deepEqual(rows.map(row => row.record.id), ['b', 'a'])
  const projected = projectReadableMacroSnapshot(rows[0], query.accessAt)
  assert.equal(projected.revision, '9007199254740993'); assert.equal(projected.factors[0].value, '1.82')
  assert.ok(!JSON.stringify(projected).includes('must-not-be-returned'))
  checks.push('published-and-superseded-history', 'actual-json-dates-decimal-revision-and-whitelist')
  // Unrelated mappings must not be aggregated for these two selected snapshots.
  const unrelated = Array.from({ length: 2000 }, (_, i) => [`unrelated-${i}`, 1, 'noise', '2026-09-08'])
  await connection.query('INSERT INTO macro_snapshot_observations (snapshot_id,observation_id,factor_code,created_at_utc) VALUES ?', [unrelated])
  assert.deepEqual((await reader.list(query)).map(row => row.record.id), ['b', 'a'])
  const [explanation] = await connection.execute('EXPLAIN ANALYZE ' + lastQuery[0], lastQuery[1])
  queryPlan = Object.values(explanation[0])[0]
  assert.match(queryPlan, /Index lookup on m .*snapshot_id=p.id/)
  checks.push('indexed-per-snapshot-lineage-with-2000-unrelated-mappings')
  assert.deepEqual((await reader.list({ ...query, latest: true })).map(row => row.record.id), ['b'])
  assert.deepEqual((await reader.list({ ...query, after: { publishedAt: rows[0].record.publishedAt, id: 'b' } })).map(row => row.record.id), ['a'])
  assert.equal((await reader.list({ ...query, id: 'a', limit: 1 })).length, 1)
  assert.deepEqual(await reader.list({ ...query, id: 'unknown' }), [])
  assert.deepEqual(await reader.list({ ...query, asOf: '2026-09-07T00:00:00.000Z' }), [])
  checks.push('latest-id-and-tie-pagination', 'missing-and-future-publication-excluded')
  assert.deepEqual(await reader.list({ ...query, latest: true, accessAt: '2026-09-10T00:00:00.000Z' }), [])
  for (const update of ["status='suspended'", 'display_allowed=0', 'derived_data_allowed=0',
    "license_expires_at_utc='2026-09-09'", "retired_at_utc='2026-09-09'"]) {
    await connection.query(`UPDATE macro_data_sources SET ${update} WHERE id=1`)
    assert.deepEqual(await reader.list(query), [])
    await connection.query("UPDATE macro_data_sources SET status='approved',display_allowed=1,derived_data_allowed=1,license_expires_at_utc=NULL,retired_at_utc=NULL WHERE id=1")
  }
  checks.push('expired-latest-and-source-permission-denied')
  await connection.query("UPDATE macro_research_snapshots SET publication_status='draft' WHERE id='b'")
  assert.deepEqual(await reader.list({ ...query, id: 'b' }), [])
  await connection.query("UPDATE macro_research_snapshots SET publication_status='published' WHERE id='b'")
  await connection.query("DELETE FROM macro_snapshot_observations WHERE snapshot_id='a'")
  assert.deepEqual(await reader.list({ ...query, id: 'a' }), [])
  // LIKE copies no foreign keys. This deliberate dangling link exercises LEFT JOIN denial.
  await connection.query("INSERT INTO macro_snapshot_observations VALUES ('b',999,'HIDDEN','2026-09-08')")
  assert.deepEqual(await reader.list({ ...query, id: 'b' }), [])
  checks.push('draft-empty-and-dangling-lineage-denied')
  await connection.query("DELETE FROM macro_snapshot_observations WHERE observation_id=999")
  await connection.query("UPDATE macro_observations SET ingested_at_utc='2026-09-09' WHERE id=1")
  const future = await reader.list({ ...query, id: 'b' })
  assert.throws(() => projectReadableMacroSnapshot(future[0], query.accessAt), /macro_snapshot_lineage_invalid/)
  checks.push('future-ingestion-rejected-by-projection')
  await connection.rollback()
  const [[remaining]] = await connection.query('SELECT COUNT(*) n FROM macro_observations')
  assert.equal(Number(remaining.n), 0)
  checks.push('temporary-writes-rolled-back')
  await output.writeFile(JSON.stringify({ kind: 'macro-snapshot-reader-mysql/v1', passed: true, observedAt: new Date().toISOString(), identity, checks, queryPlan,
    scope: 'Unmodified compiled query against permanent schema and session-local LIKE tables. No SQL identifier rewriting, permanent writes, providers or service restart. LIKE does not copy foreign keys; deliberate dangling links test rejection. Positive fixtures rolled back; not source calendar, query-scale or HTTP validation.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, checks, driverErrors, code: 'macro_snapshot_probe_failed',
    failureKind: error instanceof assert.AssertionError ? 'assertion' : 'reader-or-storage', driverCode: error.code }) + '\n')
  console.log(JSON.stringify({ passed: false, checks, driverErrors, code: error.code }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  await pool.end(); await output.sync(); await output.close()
}
