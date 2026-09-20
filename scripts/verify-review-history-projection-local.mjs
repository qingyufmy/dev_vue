import { projectArchivedReviewCase } from './lib/review-history-case-projection.mjs'
import { chunkReviewHistory, restoreReviewHistory } from './lib/review-history-chunks.mjs'
import { reviewHistoryGraph, readReviewHistoryBundle, validateReviewHistoryBundle, projectLegacyReviewVersions } from './lib/review-history-bundle.mjs'
import { assertLegacyReviewContent } from '../server/dist-v4/modules/reviews/domain/legacy-review-content.js'
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-transition-inventory/v1', passed: false, writes: 0, cases: [], tables: [] }
let db
try {
  db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  report.kind = 'review-history-bundle-validation/v1'
  report.projectedCases = 0; report.projectedVersions = 0
  report.chunkCount = 0; report.chunkRoundtripVerified = true
  report.bundles = []; report.versions = 0; report.approvedCases = 0
  for (const table of Object.keys(reviewHistoryGraph)) {
    const [cases] = await db.query('SELECT CAST(id AS CHAR) id FROM ' + table + ' ORDER BY id')
    for (const { id } of cases) {
      const bundle = await readReviewHistoryBundle(db, table, id)
      const projection = projectArchivedReviewCase(bundle, { archiveRunId: '1c2e3dd7-afa6-f810-96a4-f5f97febc668', accountId: bundle.rows[table][0].trading_account_id })
      assert.equal(projection.caseRow.status, 'archived'); assert.ok(projection.versions.every(version => version.row.trade_count === null))
      report.projectedCases++; report.projectedVersions += projection.versions.length
      const chunks = chunkReviewHistory(bundle)
      assert.deepEqual(restoreReviewHistory(chunks), bundle); report.chunkCount += chunks.length
      const check = validateReviewHistoryBundle(bundle), versions = projectLegacyReviewVersions(bundle)
      for (const version of versions) assertLegacyReviewContent(version.content)
      report.bundles.push({ table, id, ...check, bytes: Buffer.byteLength(JSON.stringify(bundle)) })
      report.versions += versions.length
      if (bundle.rows[table][0].approved_version_id !== null) report.approvedCases++
    }
  }
  const totals = {}
  for (const bundle of report.bundles) for (const [name, count] of Object.entries(bundle.rowCounts)) totals[name] = (totals[name] ?? 0) + count
  for (const [table, count] of Object.entries(totals)) {
    const [[actual]] = await db.query('SELECT COUNT(*) n FROM ' + table)
    assert.equal(Number(actual.n), count, 'review_history_unassigned_rows:' + table)
  }
  report.allSourceRowsCovered = true; report.rowCounts = totals
  report.caseCount = report.bundles.length
  assert.equal(report.caseCount, 183); assert.equal(report.versions, 34); assert.equal(report.approvedCases, 11)
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name; report.errorMessage = error?.message; process.exitCode = 1 }
finally {
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({passed:report.passed,errorCode:report.errorCode,cases:report.caseCount,versions:report.versions,approvedCases:report.approvedCases}))
}
