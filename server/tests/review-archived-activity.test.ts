import { expect, it } from 'vitest'
import { projectReviewArchivedActivity } from '../src/modules/reviews/infrastructure/review-archived-activity-projection.js'

const fixture = () => ({ table: 'period_review_cases', id: '1', rows: {
  period_review_jobs: [{ id: '2', period_case_id: '1', status: 'running', progress_stage: null,
    attempt_count: '3', last_error_code: null, created_at: '2026-09-01 12:00:00',
    updated_at: '2026-09-01 12:01:00', completed_at: null, frozen_runtime_json: 'private-config' }],
  period_review_job_events: [{ id: '3', period_case_id: '1', job_id: '2', stage: null,
    event_status: 'running', message_code: null, created_at: '2026-09-01 12:01:00' }],
} })

it('keeps original status and UTC while excluding private source configuration', () => {
  const result = projectReviewArchivedActivity(fixture())
  expect(result.jobs[0]).toMatchObject({ originalStatus: 'running', attempts: 3, createdAt: '2026-09-01T12:00:00.000Z' })
  expect(result.events[0]?.jobId).toBe(result.jobs[0]?.id)
  expect(JSON.stringify(result)).not.toContain('private-config')
})

it('rejects cross-case, missing-parent, duplicate and incomplete archive activity', () => {
  const mutations = [
    (b: ReturnType<typeof fixture>) => { b.rows.period_review_jobs[0]!.period_case_id = '9' },
    (b: ReturnType<typeof fixture>) => { b.rows.period_review_job_events[0]!.job_id = '9' },
    (b: ReturnType<typeof fixture>) => { b.rows.period_review_jobs.push(b.rows.period_review_jobs[0]!) },
    (b: ReturnType<typeof fixture>) => { b.rows.period_review_jobs[0]!.created_at = '2026-02-30 00:00:00' },
    (b: ReturnType<typeof fixture>) => { Reflect.deleteProperty(b.rows, 'period_review_jobs') },
    (b: ReturnType<typeof fixture>) => { Reflect.set(b.rows, 'manual_trade_review_jobs', []) },
  ]
  for (const mutate of mutations) {
    const bundle = fixture(); mutate(bundle)
    expect(() => projectReviewArchivedActivity(bundle)).toThrow('review_archive_activity_invalid')
  }
})

it('does not invent output presence for incomplete stage records', () => {
  const stage = { id: '3', case_id: '1', job_id: '2', generation_no: '1', stage: 'analysis', status: 'done',
    input_hash: null, normalized_output_hash: null, last_error_code: null,
    created_at: '2026-09-01 12:01:00', completed_at: null }
  const job = { ...fixture().rows.period_review_jobs[0], case_id: '1' }
  const bundle = { table: 'manual_trade_review_cases', id: '1', rows: {
    manual_trade_review_jobs: [job], manual_trade_review_stage_runs: [stage],
  } }
  expect(() => projectReviewArchivedActivity(bundle)).toThrow('review_archive_activity_invalid')
  Reflect.set(stage, 'normalized_output_json', null)
  expect(projectReviewArchivedActivity(bundle).stages[0]?.hasOutput).toBe(false)
  Reflect.set(stage, 'normalized_output_json', '{}')
  expect(projectReviewArchivedActivity(bundle).stages[0]?.hasOutput).toBe(true)
})
