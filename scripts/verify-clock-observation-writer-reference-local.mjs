import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadClockObservationSource } from './lib/clock-observation-source.mjs'
import { createMysqlHistoricalClockReader } from '../server/dist-v4/modules/trading/infrastructure/mysql-historical-clock-reader.js'
import { appendClockObservation } from '../server/dist-v4/modules/trading/infrastructure/mysql-clock-observation-writer.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600)
const name = 'dev_vue_clock_ref_' + randomUUID().replaceAll('-', '')
const report = { kind: 'clock-observation-writer-reference/v1', passed: false, existingDatabaseWrites: 0, referenceDatabaseRemoved: false }
let db, created = false
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  db = await mysql.createConnection({ ...credential, timezone: 'Z', dateStrings: true })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  await db.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  await db.query('USE `' + name + '`'); await db.query("SET SESSION time_zone='+00:00'")
  for (const sql of [
    'CREATE TABLE trading_accounts (id BIGINT UNSIGNED PRIMARY KEY)',
    'CREATE TABLE users (id INT PRIMARY KEY)',
    'CREATE TABLE trading_account_ownership_intervals (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY)',
    'CREATE TABLE terminal_profiles (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY)',
  ]) await db.query(sql)
  for (const sql of (await loadClockObservationSource(new URL('../', import.meta.url))).statements) await db.query(sql)
  await db.query('INSERT INTO trading_accounts VALUES (5)'); await db.query('INSERT INTO users VALUES (7)')
  await db.query("INSERT INTO trading_account_ownership_intervals VALUES ('interval')"); await db.query("INSERT INTO terminal_profiles VALUES ('profile')")
  const input = { route: { accountId: '5', userId: 7, terminalProfileId: 'profile', terminalInstanceId: 'terminal', connectionEpoch: 9, connectionId: 'connection' },
    projection: { resource: 'account.metrics', resourceId: 'current', accountId: '5', revision: 12,
      data: { id: '5', revision: 12, timezoneOffsetMinutes: null, clockStatus: 'unavailable', observedAt: '2026-09-11T00:00:00.000Z' } } }
  const ownership = { intervalId: 'interval', ownershipRevision: '3' }, effective = { timezoneOffsetMinutes: 180, clockStatus: 'stale' }
  await db.beginTransaction(); await appendClockObservation(db, input, ownership, effective); await db.rollback()
  assert.equal(Number((await db.query('SELECT COUNT(*) n FROM terminal_clock_observations_v4'))[0][0].n), 0)
  await db.beginTransaction(); await appendClockObservation(db, input, ownership, effective); await db.commit()
  const [[row]] = await db.query('SELECT reported_offset_minutes,reported_status,effective_offset_minutes,effective_status,connection_epoch,observed_at_utc,evidence_sha256 FROM terminal_clock_observations_v4')
  assert.equal(row.reported_offset_minutes, null); assert.equal(row.reported_status, 'unavailable')
  assert.equal(row.effective_offset_minutes, 180); assert.equal(row.effective_status, 'stale')
  assert.equal(row.observed_at_utc, '2026-09-11 00:00:00.000'); assert.match(row.evidence_sha256, /^[a-f0-9]{64}$/)
  await assert.rejects(appendClockObservation(db, input, ownership, effective), { code: 'ER_DUP_ENTRY' })
  await assert.rejects(db.query("UPDATE terminal_clock_observations_v4 SET reported_status='calibrated'"), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
  const reader = createMysqlHistoricalClockReader(db)
  const boundary = Date.parse(input.projection.data.observedAt) + 60_000
  const clockScope = { userId: 7, accountId: '5', ownershipIntervalId: 'interval', utcMsc: boundary, asOfUtcMsc: Date.now() + 60_000 }
  assert.equal(await reader.read(clockScope), null)
  const calibrated = { timezoneOffsetMinutes: 180, clockStatus: 'calibrated' }
  const observation = (revision, observedAt, offset=180) => ({ ...input,
    projection: { ...input.projection, revision, data: { ...input.projection.data, revision, observedAt: new Date(observedAt).toISOString(), timezoneOffsetMinutes: offset, clockStatus: 'calibrated' } } })
  await appendClockObservation(db, observation(13,boundary-1000), ownership, calibrated)
  await appendClockObservation(db, observation(14,boundary+1000), ownership, calibrated)
  const result = await reader.read(clockScope)
  assert.equal(result.offsetMinutes,180); assert.match(result.evidenceRef,/^clock-boundary:v1:[a-f0-9]{64}$/)
  assert.equal(await reader.read({...clockScope,userId:8}),null)
  assert.equal(await reader.read({...clockScope,utcMsc:boundary-600_000}),null)
  assert.equal(await reader.read({...clockScope,asOfUtcMsc:boundary}),null)
  await db.beginTransaction()
  const stale = observation(15,boundary); stale.projection.data.clockStatus='stale'
  await appendClockObservation(db, stale, ownership, effective)
  assert.equal(await reader.read(clockScope),null); await db.rollback()
  await db.beginTransaction()
  await db.query('UPDATE terminal_clock_observations_v4 SET reported_offset_minutes=120 WHERE projection_revision=14')
  assert.equal(await reader.read(clockScope),null); await db.rollback()
  await db.beginTransaction()
  const replaced = observation(15,boundary+500); replaced.route={...replaced.route,connectionEpoch:10}
  await appendClockObservation(db,replaced,ownership,calibrated)
  assert.equal(await reader.read(clockScope),null); await db.rollback()
  assert.equal((await reader.read(clockScope)).evidenceRef,result.evidenceRef)
  const localMidnightMsc = Date.parse('2026-09-11T00:00:00.000Z')
  const resolvedBoundary = localMidnightMsc-180*60_000
  await appendClockObservation(db,observation(17,resolvedBoundary-1000),ownership,calibrated)
  await appendClockObservation(db,observation(18,resolvedBoundary+1000),ownership,calibrated)
  const localScope = { userId: 7, accountId: '5', ownershipIntervalId: 'interval', localMidnightMsc, asOfUtcMsc: clockScope.asOfUtcMsc }
  assert.equal((await reader.resolveLocal(localScope)).utcMsc,resolvedBoundary)
  await db.beginTransaction()
  const secondBoundary = localMidnightMsc-120*60_000
  await appendClockObservation(db,observation(19,secondBoundary-1000,120),ownership,{timezoneOffsetMinutes:120,clockStatus:'calibrated'})
  await appendClockObservation(db,observation(20,secondBoundary+1000,120),ownership,{timezoneOffsetMinutes:120,clockStatus:'calibrated'})
  assert.equal(await reader.resolveLocal(localScope),null)
  await db.rollback()
  report.checks = ['actual-writer-sql', 'transaction-rollback', 'raw-status-preserved', 'duplicate-rejected', 'calibrated-null-rejected','historical-boundary-bracket','foreign-user-rejected','missing-and-late-observation-rejected','nearest-stale-not-skipped','hash-tampering-rejected','replaced-route-rejected','boundary-reference-replay','local-midnight-resolved-from-history','ambiguous-local-midnight-rejected']
  report.scope = 'Synthetic route and minimal parent fixtures; actual writer and canonical table. Not live Bridge calibration.'
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name; report.errorLocations = String(error?.stack ?? "").split("\n").filter(line => /^\s+at /.test(line)).slice(0,3); process.exitCode = 1 }
finally {
  if (db) { try { await db.rollback(); if (created) { await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true } } finally { await db.end() } }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close(); console.log(JSON.stringify(report))
}
