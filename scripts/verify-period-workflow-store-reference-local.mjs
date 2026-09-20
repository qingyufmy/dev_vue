import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadPeriodWorkflowSource } from './lib/period-workflow-source.mjs'
import { createMysqlPeriodReviewWorkflow } from '../server/dist-v4/modules/reviews/composition.js'
import { createPeriodReviewWorkflow } from '../server/dist-v4/modules/reviews/index.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600)
const name = 'dev_vue_period_ref_' + randomUUID().replaceAll('-', '')
const report = { kind: 'period-workflow-store-reference/v1', passed: false, existingDatabaseWrites: 0, referenceDatabaseRemoved: false }
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
  ]) await db.query(sql)
  for (const sql of (await loadPeriodWorkflowSource(new URL('../', import.meta.url))).statements) await db.query(sql)
  const interval = randomUUID(), id = randomUUID(), historyTaskId = randomUUID()
  await db.query('INSERT INTO trading_accounts VALUES (5)'); await db.query('INSERT INTO users VALUES (7)')
  await db.execute('INSERT INTO trading_account_ownership_intervals VALUES (?)',[interval])
  const scope = {userId:7,accountId:'5',ownershipIntervalId:interval,kind:'daily',key:'2026-09-10'}
  const store = createMysqlPeriodReviewWorkflow(db, async accountId => {await db.execute('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE',[accountId])})
  await db.beginTransaction();await store.register(id,scope);await db.rollback()
  assert.equal((await db.query('SELECT COUNT(*) n FROM period_review_workflows_v4'))[0][0].n,0)
  await db.beginTransaction();await store.register(id,scope);await db.commit()
  await db.beginTransaction();assert.equal((await store.register(randomUUID(),scope)).id,id);await db.commit()
  const start = Date.parse('2026-09-09T21:00:00.000Z'),endTime=start+86400000
  let requests=0
  const engine=createPeriodReviewWorkflow({async authorize(){return true},async plan(){return {period:{kind:'daily',key:scope.key,
    start:{utcMsc:start,offsetMinutes:180,evidenceRef:'clock:start'},end:{utcMsc:endTime,offsetMinutes:180,evidenceRef:'clock:end'}},
    historyStartUtcMsc:start-86400000,asOfUtcMsc:endTime+60000}},nextHistoryTaskId(){return historyTaskId},
    async request(){requests++;return {status:'completed'}},async collect(){return {status:'empty'}}})
  await db.beginTransaction();assert.equal((await store.run(id,engine.advance)).phase,'history');await db.rollback()
  assert.equal((await db.query('SELECT phase FROM period_review_workflows_v4'))[0][0].phase,'planning')
  await db.beginTransaction();assert.equal((await store.run(id,engine.advance)).phase,'history');await db.commit()
  assert.equal(requests,0)
  await db.beginTransaction();assert.equal((await store.run(id,engine.advance)).phase,'succeeded');await db.commit()
  assert.equal(requests,1)
  await db.beginTransaction();assert.equal((await store.run(id,engine.advance)).status,'unchanged');await db.commit()
  assert.equal(requests,1)
  await db.beginTransaction();await db.query("UPDATE period_review_workflows_v4 SET progress_sha256=REPEAT('a',64)")
  await assert.rejects(store.run(id,engine.advance),/period_workflow_progress_corrupt/);await db.rollback()
  report.checks=['registration-rollback','unique-scope-replay','transition-rollback','plan-persisted-before-request','empty-period-completion','completed-no-reactivation','corrupt-progress-rejected']
  report.scope='Actual workflow engine and MySQL store; authorization, clock, history and review ports are synthetic. No live scheduler or terminal.'
  report.passed=true
} catch (error) { report.errorCode = error?.code ?? error?.name; report.errorLocations = String(error?.stack ?? "").split("\n").filter(line => /^\s+at /.test(line)).slice(0,3); process.exitCode = 1 }
finally {
  if (db) { try { await db.rollback(); if (created) { await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true } } finally { await db.end() } }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close(); console.log(JSON.stringify(report))
}
