import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import Fastify from 'fastify'
import { createMysqlReviewHttp } from '../server/dist-v4/modules/reviews/composition.js'
import { createHash } from 'node:crypto'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-history-current-application-readonly/v1', passed: false, writes: 0, applicationCredentialsUsed: true, realAuthenticationVerified: false }
let db
try {
  db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  let userId = 1
  const app = Fastify()
  try {
    await app.register(createMysqlReviewHttp({ execute: db.execute.bind(db) }, { authenticate: async () => ({ userId }), assertWrite: () => { throw Error('readonly_probe') } }))
    const [cases] = await db.query("SELECT id,user_id,legacy_source_table,legacy_id,current_version_id,CAST(updated_at_utc AS CHAR) updated FROM review_cases_v4 WHERE legacy_source_table IS NOT NULL ORDER BY id")
    assert.equal(cases.length, 183)
    let versions = 0, foreignOwnerRejections = 0, historicalVersions = 0, metadataCount = 0, versionAccessRejections = 0
    const versionIds = new Set()
    for (const row of cases) {
      userId = Number(row.user_id)
      const response = await app.inject('/api/v4/review-cases/' + row.id)
      assert.equal(response.statusCode, 200)
      const detail = response.json().data
      assert.equal(detail.summary.status, 'archived'); assert.equal(String(detail.summary.user_id), String(userId))
      assert.equal(detail.summary.updated_at, row.updated.replace(' ', 'T') + (row.updated.includes('.') ? 'Z' : '.000Z'))
      assert.equal(detail.current_version?.id ?? null, row.current_version_id)
      if (detail.current_version) {
        const content = detail.current_version.content
        assert.equal(content.schema_version, 'review.legacy.v1'); assert.equal(detail.current_version.conclusion, null)
        const table = { period_review_cases: 'period_review_versions', manual_trade_review_cases: 'manual_trade_review_versions', trade_review_cases: 'trade_review_versions' }[row.legacy_source_table]
        assert.equal(content.source_table, table)
        const [[original]] = await db.execute('SELECT content_json FROM ' + table + ' WHERE id=?', [content.source_id])
        assert.equal(content.raw_text, original.content_json)
        assert.equal(content.source_sha256, createHash('sha256').update(original.content_json).digest('hex')); versions++
      }
      const metadataResponse = await app.inject('/api/v4/review-cases/' + row.id + '/history')
      assert.equal(metadataResponse.statusCode, 200)
      const metadata = metadataResponse.json().data
      assert.equal(metadata.source_table, row.legacy_source_table); assert.equal(metadata.source_id, row.legacy_id); metadataCount++
      let cursor = null
      do {
        const page = await app.inject('/api/v4/review-cases/' + row.id + '/versions?page_size=1' + (cursor === null ? '' : '&before_version=' + cursor))
        assert.equal(page.statusCode, 200)
        const value = page.json().data
        for (const item of value.items) {
          assert.ok(!versionIds.has(item.id)); versionIds.add(item.id)
          const body = await app.inject('/api/v4/review-cases/' + row.id + '/versions/' + item.id)
          assert.equal(body.statusCode, 200)
          const version = body.json().data, content = version.content
          assert.equal(version.review_case_id, row.id); assert.equal(version.id, item.id)
          const sourceTable = { period_review_cases: 'period_review_versions', manual_trade_review_cases: 'manual_trade_review_versions', trade_review_cases: 'trade_review_versions' }[row.legacy_source_table]
          assert.equal(content.source_table, sourceTable)
          const [[source]] = await db.execute('SELECT content_json FROM ' + sourceTable + ' WHERE id=?', [content.source_id])
          assert.equal(content.raw_text, source.content_json); historicalVersions++
          userId = 28
          assert.equal((await app.inject('/api/v4/review-cases/' + row.id + '/versions/' + item.id)).statusCode, 404)
          userId = Number(row.user_id)
          const other = cases.find(candidate => candidate.id !== row.id && Number(candidate.user_id) === userId)
          assert.ok(other)
          assert.equal((await app.inject('/api/v4/review-cases/' + other.id + '/versions/' + item.id)).statusCode, 404)
          versionAccessRejections += 2
        }
        cursor = value.next_before_version
      } while (cursor !== null)
      userId = 28
      for (const path of ['/history', '/versions']) assert.equal((await app.inject('/api/v4/review-cases/' + row.id + path)).statusCode, 404)

      const denied = await app.inject('/api/v4/review-cases/' + row.id)
      assert.equal(denied.statusCode, 404); foreignOwnerRejections++
    }
    const list = await app.inject('/api/v4/review-cases?page_size=50')
    assert.equal(list.statusCode, 200); assert.equal(list.json().data.items.length, 0)
    assert.equal(historicalVersions, 34); assert.equal(metadataCount, 183)
    Object.assign(report, { passed: true, historicalVersions, metadataCount, versionAccessRejections, cases: cases.length, currentVersions: versions, foreignOwnerRejections, originalTextVerified: true, utcReadVerified: true })
  } finally { await app.close() }
} catch (error) {
  report.errorCode = error?.code ?? error?.name
  report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
