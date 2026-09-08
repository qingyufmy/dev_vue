import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { MysqlCalendarReader } from '../server/dist-v4/modules/market/infrastructure/mysql-calendar-reader.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.31.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
const checks = []
const driverErrors = []
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.timezone, '+00:00')
  const now = '2026-09-09T00:00:00.000Z'
  const query = { from: now, to: now, limit: 101, importance: 'high' }
  const actual = new MysqlCalendarReader(connection)
  assert.deepEqual(await actual.list(query, now), [])
  assert.equal(await actual.find('local-probe-nonexistent', now), null)
  checks.push('unmodified-sql-on-current-empty-permanent-tables')
  // Session-local schema shadows: no permanent table DDL/DML and no provider activity.
  await connection.query(`CREATE TEMPORARY TABLE macro_data_sources(id INT PRIMARY KEY,status VARCHAR(20),display_allowed INT,
    retired_at_utc DATETIME(3),license_reviewed_at_utc DATETIME(3),license_expires_at_utc DATETIME(3)) ENGINE=InnoDB`)
  await connection.query(`CREATE TEMPORARY TABLE economic_calendar_events(id VARCHAR(36) PRIMARY KEY,source_id INT,provider_event_id VARCHAR(191),
    country_code CHAR(2),currency_code CHAR(3),title VARCHAR(300),scheduled_at_utc DATETIME(3),time_precision VARCHAR(20),importance VARCHAR(20),
    period_label VARCHAR(128),unit VARCHAR(64),status VARCHAR(20),provider_updated_at_utc DATETIME(3),revision BIGINT UNSIGNED,
    created_at_utc DATETIME(3),updated_at_utc DATETIME(3)) ENGINE=InnoDB`)
  await connection.query(`CREATE TEMPORARY TABLE economic_calendar_event_revisions(id VARCHAR(36) PRIMARY KEY,event_id VARCHAR(36),revision_number INT,
    scheduled_at_utc DATETIME(3),status VARCHAR(20),previous_value DECIMAL(30,10),consensus_value DECIMAL(30,10),actual_value DECIMAL(30,10),
    revised_previous_value DECIMAL(30,10),provider_updated_at_utc DATETIME(3),available_at_utc DATETIME(3),ingested_at_utc DATETIME(3)) ENGINE=InnoDB`)
  await connection.beginTransaction()
  await connection.query("INSERT INTO macro_data_sources VALUES (1,'approved',1,NULL,'2026-01-01',NULL)")
  for (const id of ['a', 'b']) await connection.execute(`INSERT INTO economic_calendar_events VALUES (?,1,?,'US','USD','CPI',
    '2026-09-09','exact','high',NULL,'percent','scheduled',NULL,9007199254740993,'2026-01-01','2026-01-01')`, [id, id])
  await connection.query(`INSERT INTO economic_calendar_event_revisions VALUES
    ('r1','a',1,'2026-09-09','released',3.1,3.2,3.3,NULL,NULL,'2026-09-08','2026-09-08'),
    ('r2','a',2,'2026-09-09','revised',3.1,3.2,3.4,NULL,NULL,'2026-09-10','2026-09-08'),
    ('r3','a',3,'2026-09-09','revised',3.1,3.2,3.5,NULL,NULL,'2026-09-08','2026-09-10')`)
  // MySQL cannot reopen one TEMPORARY table under two aliases. A fixed identical
  // candidate copy supports the correlated selector; production SQL above is unmodified.
  await connection.query('CREATE TEMPORARY TABLE calendar_revision_candidates AS SELECT * FROM economic_calendar_event_revisions')
  const reader = new MysqlCalendarReader({ async execute(...args) {
    args[0] = args[0].replace('FROM economic_calendar_event_revisions v', 'FROM calendar_revision_candidates v')
    try { return await connection.execute(...args) }
    catch (error) { driverErrors.push({ code: error.code, errno: error.errno, sqlState: error.sqlState }); throw error }
  } })
  const first = await reader.find('a', now)
  assert.equal(first.actual, '3.3000000000'); assert.equal(first.status, 'released')
  assert.equal(first.revision, '9007199254740993'); assert.equal(first.scheduled_at, now)
  checks.push('future-available-and-future-ingested-revisions-excluded', 'decimal-and-bigint-text-preserved', 'utc-milliseconds')
  assert.deepEqual((await reader.list(query, now)).map(row => row.id), ['a', 'b'])
  assert.deepEqual((await reader.list({ ...query, after: { scheduledAt: now, id: 'a' } }, now)).map(row => row.id), ['b'])
  assert.equal((await reader.find('b', now)).actual, null)
  checks.push('same-time-id-pagination', 'scheduled-without-numeric-revision-remains-null')
  for (const update of ["status='suspended'", 'display_allowed=0', "license_expires_at_utc='2026-09-08'", "retired_at_utc='2026-09-08'"]) {
    await connection.query(`UPDATE macro_data_sources SET ${update} WHERE id=1`)
    assert.equal(await reader.find('a', now), null)
    await connection.query("UPDATE macro_data_sources SET status='approved',display_allowed=1,license_expires_at_utc=NULL,retired_at_utc=NULL WHERE id=1")
  }
  checks.push('suspended-hidden-expired-retired-sources-denied')
  assert.equal(await reader.find('missing', now), null)
  await connection.rollback()
  const [[remaining]] = await connection.query('SELECT COUNT(*) n FROM economic_calendar_events')
  assert.equal(Number(remaining.n), 0)
  checks.push('missing-detail-null', 'temporary-fixture-rollback')
  await output.writeFile(JSON.stringify({ kind: 'calendar-reader-mysql/v1', passed: true, observedAt: new Date().toISOString(), identity, checks,
    scope: 'Unmodified compiled SQL on current empty permanent tables. Positive cases use session-local temporary tables and an identical revision candidate copy to bypass MySQL TEMPORARY-table reopen restriction; only that inner table identifier is remapped. All fixture DML rolled back; no permanent writes, provider data, runtime restart or publication proof.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, code: 'calendar_reader_probe_failed', checks,
    driverErrors, failureKind: error instanceof assert.AssertionError ? 'assertion' : 'reader-or-storage' }) + '\n')
  console.log(JSON.stringify({ passed: false, driverErrors, code: error.code }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  await pool.end(); await output.sync(); await output.close()
}
