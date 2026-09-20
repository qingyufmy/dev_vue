import Fastify from 'fastify'
import { createMysqlReviewHttp } from '../server/dist-v4/modules/reviews/composition.js'
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { readReviewHistoryArchive } from './lib/review-history-archive-reader.mjs'
import { projectReviewArchivedActivity } from '../server/dist-v4/modules/reviews/infrastructure/review-archived-activity-projection.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const manifest = JSON.parse(await readFile(new URL('../docs/architecture/review-history-bundles-v3-20260911.json', import.meta.url), 'utf8'))
assert.equal(manifest.passed, true)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-archived-activity/v1', passed: false, writes: 0, cases: 0, jobs: 0, events: 0, stages: 0, httpVerified: false }
let db, app
try {
  db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  for (const source of manifest.bundles) {
    const bundle = await readReviewHistoryArchive(db, { runId: '1c2e3dd7-afa6-f810-96a4-f5f97febc668',
      sourceTable: source.table, sourceId: source.id, expectedBundleHash: source.sourceHash })
    const result = projectReviewArchivedActivity(bundle)
    report.cases++; report.jobs += result.jobs.length; report.events += result.events.length; report.stages += result.stages.length
  }
  assert.equal(report.cases, 183); assert.equal(report.jobs, 28); assert.equal(report.events, 7208); assert.equal(report.stages, 18)
  app = Fastify()
  let requestUser = 1
  await app.register(createMysqlReviewHttp(db, { authenticate: async () => ({ userId: requestUser }), assertWrite: async () => {} }))
  const reader = { page: async (userId, caseId, kind, options) => {
    requestUser = userId
    const response = await app.inject(`/api/v4/review-cases/${caseId}/history/${kind}?page_size=${options.limit}&offset=${options.offset}`)
    assert.equal(response.headers['cache-control'], 'no-store')
    if (response.statusCode === 404) throw new Error('review_case_not_found')
    assert.equal(response.statusCode, 200, response.body)
    const { data } = response.json()
    return { items: data.items, total: data.total, nextOffset: data.next_offset }
  } }
  const [cases] = await db.query('SELECT c.id,c.user_id FROM review_cases_v4 c JOIN review_case_history_v4 h ON h.review_case_id=c.id')
  report.runtimeCases = 0; report.runtimeJobs = 0; report.runtimeEvents = 0; report.runtimeStages = 0; report.deniedCases = 0
  for (const row of cases) {
    for (const kind of ['jobs', 'events', 'stages']) {
      let offset = 0, read = 0, total = 0
      do {
        const page = await reader.page(Number(row.user_id), row.id, kind, { limit: 100, offset })
        read += page.items.length; total = page.total; offset = page.nextOffset
      } while (offset !== null)
      assert.equal(read, total)
      report['runtime' + kind[0].toUpperCase() + kind.slice(1)] += read
    }
    await assert.rejects(reader.page(28, row.id, 'events', { limit: 100, offset: 0 }), /review_case_not_found/)
    report.deniedCases++; report.runtimeCases++
  }
  assert.equal(report.runtimeCases, report.cases)
  assert.equal(report.runtimeJobs, report.jobs); assert.equal(report.runtimeEvents, report.events); assert.equal(report.runtimeStages, report.stages)
  report.httpVerified = true; report.realAuthenticationVerified = false
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name; report.errorMessage = error?.message; process.exitCode = 1 }
finally {
  if (app) await app.close()
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
