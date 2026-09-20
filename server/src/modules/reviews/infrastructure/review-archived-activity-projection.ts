import type { ArchivedReviewActivity } from '../application/review-archived-activity.js'
import { ReviewError } from '../domain/review.js'
import { reviewIsoTime } from './review-sql-time.js'
const invalid = () => new ReviewError('review_archive_activity_invalid', 503)
const text = (value: unknown, max = 191): string => { if (typeof value !== 'string' || value.length < 1 || value.length > max) throw invalid(); return value }
const nullable = (value: unknown, max = 191) => value === null ? null : text(value, max)
const count = (value: unknown) => { const n = Number(value); if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(n)) throw invalid(); return n }
const time = (value: unknown) => { try { return reviewIsoTime(text(value, 30)) } catch { throw invalid() } }
const nullableTime = (value: unknown) => value === null ? null : time(value)
const identifier = (table: string, value: unknown) => { const id = text(value, 20); if (!/^[1-9][0-9]*$/.test(id)) throw invalid(); return `${table}:${id}` }
const outputPresent = (value: unknown) => { if (value === null) return false; if (typeof value !== 'string' || !value.trim()) throw invalid(); return true }
const digest = (value: unknown) => { const v = nullable(value, 64); if (v !== null && !/^[a-f0-9]{64}$/.test(v)) throw invalid(); return v }

/** Input must first pass archive receipt, canonical hash and original-case binding verification. */
export function projectReviewArchivedActivity(input: unknown): ArchivedReviewActivity {
  if (!input || typeof input !== 'object') throw invalid()
  const bundle = input as { table?: unknown; id?: unknown; rows?: unknown }
  const table = text(bundle.table, 64), caseId = text(bundle.id, 20)
  if (!['trade_review_cases', 'manual_trade_review_cases', 'period_review_cases'].includes(table)
    || !bundle.rows || typeof bundle.rows !== 'object' || Array.isArray(bundle.rows) || !/^[1-9][0-9]*$/.test(caseId)) throw invalid()
  const groups = bundle.rows as Record<string, unknown>
  const families: Record<string, string> = { period_review_jobs: 'period_review_cases', period_review_job_events: 'period_review_cases', manual_trade_review_jobs: 'manual_trade_review_cases', manual_trade_review_stage_runs: 'manual_trade_review_cases' }
  for (const [name, owner] of Object.entries(families)) {
    if (owner !== table && name in groups) throw invalid()
    if (owner === table && !Array.isArray(groups[name])) throw invalid()
  }
  const read = (name: string, caseKey: string) => {
    const rows = groups[name] ?? []
    if (!Array.isArray(rows) || rows.length > 10000) throw invalid()
    return rows.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
      const row = value as Record<string, unknown>
      if (row[caseKey] !== caseId) throw invalid()
      return row
    })
  }
  const jobs: ArchivedReviewActivity['jobs'] = []
  for (const [name, key] of [['period_review_jobs', 'period_case_id'], ['manual_trade_review_jobs', 'case_id']] as const) {
    for (const row of read(name, key)) jobs.push({ id: identifier(name, row.id), sourceTable: name, sourceId: text(row.id, 20),
      originalStatus: text(row.status, 32), stage: nullable(row.progress_stage, 64), attempts: count(row.attempt_count),
      errorCode: nullable(row.last_error_code, 128), createdAt: time(row.created_at), updatedAt: time(row.updated_at), completedAt: nullableTime(row.completed_at) })
  }
  const jobIds = new Set(jobs.map(row => row.id))
  if (jobIds.size !== jobs.length) throw invalid()
  const parent = (name: string, value: unknown) => { const id = identifier(name, value); if (!jobIds.has(id)) throw invalid(); return id }
  const events = read('period_review_job_events', 'period_case_id').map(row => ({ id: identifier('period_review_job_events', row.id),
    jobId: parent('period_review_jobs', row.job_id), stage: nullable(row.stage, 64), originalStatus: text(row.event_status, 32),
    messageCode: nullable(row.message_code, 128), occurredAt: time(row.created_at) }))
  const stages = read('manual_trade_review_stage_runs', 'case_id').map(row => ({ id: identifier('manual_trade_review_stage_runs', row.id),
    jobId: parent('manual_trade_review_jobs', row.job_id), generation: count(row.generation_no), stage: text(row.stage, 64),
    originalStatus: text(row.status, 32), inputHash: digest(row.input_hash), outputHash: digest(row.normalized_output_hash),
    hasOutput: outputPresent(row.normalized_output_json), errorCode: nullable(row.last_error_code, 128),
    createdAt: time(row.created_at), completedAt: nullableTime(row.completed_at) }))
  if (new Set(events.map(row => row.id)).size !== events.length || new Set(stages.map(row => row.id)).size !== stages.length) throw invalid()
  return { jobs, events, stages }
}
