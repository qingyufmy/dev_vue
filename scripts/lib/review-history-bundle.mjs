import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hash } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const reviewHistoryGraph = {
  trade_review_cases: [['trade_review_versions', 'case_id']],
  manual_trade_review_cases: [['manual_trade_review_versions', 'case_id'], ['manual_trade_review_sources', 'case_id'],
    ['manual_trade_review_jobs', 'case_id'], ['manual_trade_review_stage_runs', 'case_id'], ['manual_trade_review_counterfactual_points', 'case_id']],
  period_review_cases: [['period_review_versions', 'period_case_id'], ['period_review_sources', 'period_case_id'],
    ['period_review_jobs', 'period_case_id'], ['period_review_job_events', 'period_case_id'],
    ['period_review_derivation_jobs', 'period_case_id'], ['period_review_user_states', 'period_case_id']],
}
const sha = value => createHash('sha256').update(value).digest('hex')
const q = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return '`' + name + '`' }
const id = value => { assert.match(value, /^[1-9]\d{0,19}$/); return value }
export function legacyReviewId(table, sourceId) {
  id(sourceId)
  assert.ok(Object.keys(reviewHistoryGraph).includes(table) || Object.values(reviewHistoryGraph).flat().some(([name]) => name === table))
  const bytes = Buffer.from(sha('aurum:review-history:v1:' + table + ':' + sourceId).slice(0, 32), 'hex')
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

// Call under a consistent read transaction or the migration transaction lock.
// Only one case aggregate is retained in memory; full source strings remain intact.
export async function readReviewHistoryBundle(db, table, caseId) {
  assert.ok(Object.hasOwn(reviewHistoryGraph, table)); id(caseId)
  async function read(name, predicate, values, order = 'id') {
    const [columns] = await db.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
    assert.ok(columns.length, 'review_history_table_missing')
    const [rows] = await db.execute('SELECT ' + columns.map(({ name }) => `CAST(${q(name)} AS CHAR) ${q(name)}`).join(',')
      + ' FROM ' + q(name) + ' WHERE ' + predicate + ' ORDER BY ' + order.split(',').map(q).join(',') + ' LIMIT 10001', values)
    assert.ok(rows.length <= 10000, 'review_history_row_limit')
    return rows.map(row => ({ ...row }))
  }
  const cases = await read(table, 'id=?', [caseId]); assert.equal(cases.length, 1)
  const rows = { [table]: cases }
  for (const [name, key] of reviewHistoryGraph[table]) rows[name] = await read(name, q(key) + '=?', [caseId], name === 'period_review_user_states' ? 'period_case_id,user_id' : 'id')
  if (table === 'period_review_cases') {
    rows.period_review_monthly_checkpoints = []
    for (const job of rows.period_review_jobs) rows.period_review_monthly_checkpoints.push(...await read('period_review_monthly_checkpoints', 'period_review_job_id=?', [job.id]))
  }
  const bundle = { table, id: caseId, rows }
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) <= 64 * 1024 * 1024, 'review_history_bundle_too_large')
  validateReviewHistoryBundle(bundle)
  return bundle
}

export function validateReviewHistoryBundle(bundle) {
  const { table, rows } = bundle
  assert.ok(Object.hasOwn(reviewHistoryGraph, table)); id(bundle.id)
  assert.equal(rows[table]?.length, 1); const source = rows[table][0]; assert.equal(source.id, bundle.id)
  for (const [name, key] of reviewHistoryGraph[table]) {
    assert.ok(Array.isArray(rows[name]))
    assert.ok(rows[name].every(row => row[key] === source.id), 'review_history_cross_case')
    const keys = rows[name].map(row => row.id ?? `${row.period_case_id}:${row.user_id}`)
    assert.equal(new Set(keys).size, keys.length, 'review_history_duplicate_row')
  }
  const versionTable = reviewHistoryGraph[table][0][0], versions = rows[versionTable]
  for (const pointer of [source.current_version_id, source.approved_version_id])
    assert.ok(pointer === null || versions.some(row => row.id === pointer), 'review_history_version_pointer_missing')
  assert.equal(new Set(versions.map(row => row.version_no)).size, versions.length, 'review_history_duplicate_version')
  for (const version of versions) {
    id(version.id); id(version.version_no)
    assert.ok(BigInt(version.version_no) <= 4294967295n)
    if (version.parent_version_id !== null) assert.ok(versions.some(parent => parent.id === version.parent_version_id
      && BigInt(parent.version_no) < BigInt(version.version_no)), 'review_history_parent_invalid')
    assert.equal(typeof version.content_json, 'string')
    assert.ok(Buffer.byteLength(version.content_json) <= 16_777_215)
    assert.ok(['ai', 'model', 'user'].includes(version.author_type), 'review_history_author_unknown')
    assert.ok(version.content_hash === null || /^[a-f0-9]{64}$/.test(version.content_hash), 'review_history_content_hash_invalid')
    inspectWallClock(version.created_at)
  }
  const jobs = rows[table === 'period_review_cases' ? 'period_review_jobs' : 'manual_trade_review_jobs'] ?? []
  for (const name of ['manual_trade_review_stage_runs', 'manual_trade_review_counterfactual_points', 'period_review_job_events', 'period_review_monthly_checkpoints'])
    for (const row of rows[name] ?? []) assert.ok(jobs.some(job => job.id === (row.job_id ?? row.period_review_job_id)), 'review_history_job_missing')
  for (const row of rows.period_review_derivation_jobs ?? []) assert.ok(versions.some(version => version.id === row.period_version_id), 'review_history_derivation_version_missing')
  for (const row of rows.period_review_user_states ?? []) assert.ok(row.last_seen_version_id === null || versions.some(version => version.id === row.last_seen_version_id), 'review_history_seen_version_missing')
  return { sourceHash: hash(bundle), rowCounts: Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, values.length])) }
}

export function projectLegacyReviewVersions(bundle) {
  validateReviewHistoryBundle(bundle)
  const sourceTable = reviewHistoryGraph[bundle.table][0][0], caseId = legacyReviewId(bundle.table, bundle.id)
  return bundle.rows[sourceTable].map(row => {
    const rawText = row.content_json, sourceSha256 = sha(rawText)
    return { id: legacyReviewId(sourceTable, row.id), caseId, versionNumber: Number(row.version_no),
      authorKind: row.author_type === 'user' ? 'user' : 'ai', authorUserId: row.author_user_id,
      conclusion: null, parentVersionId: row.parent_version_id === null ? null : legacyReviewId(sourceTable, row.parent_version_id),
      changeNote: row.change_note, createdAt: inspectWallClock(row.created_at).canonicalWallClock,
      content: { schemaVersion: 'review.legacy.v1', sourceTable, sourceId: row.id, sourceSha256,
        originalContentHash: row.content_hash, rawText } }
  })
}
