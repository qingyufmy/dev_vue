import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const read = file => readFileSync(new URL(file, root), 'utf8')

describe('manual trade review backend boundaries', () => {
  it('appends migration 178 with independent case/source/version/job tables', () => {
    const migration = read('server/migrations.js')
    expect(migration).toContain("id: '178_manual_trade_strategy_review'")
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS manual_trade_review_cases')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS manual_trade_review_sources')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS manual_trade_review_versions')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS manual_trade_review_jobs')
    expect(migration).toContain('UNIQUE KEY uk_manual_review_client_request (user_id, client_request_id)')
    expect(migration).not.toContain('uk_platform_experience_manual_candidate')
    expect(migration).not.toContain("'manual_review_case_id'")
    expect(migration).not.toContain("'manual_review_version_id'")
    expect(migration).not.toContain("'manual_review_candidate_id'")
    expect(migration.lastIndexOf("id: '178_manual_trade_strategy_review'")).toBeGreaterThan(migration.lastIndexOf("id: '177_"))
  })

  it('guards every manual review route with platform content management and owner-scoped service calls', () => {
    const routes = read('server/routes/ai/index.js')
    const paths = [
      '/ai/manual-trade-reviews/eligible-trades', '/ai/manual-trade-reviews', '/ai/manual-trade-reviews/:id',
      '/ai/manual-trade-reviews/:id/job-status', '/ai/manual-trade-reviews/:id/edit',
      '/ai/manual-trade-reviews/:id/confirm',
      '/ai/manual-trade-reviews/:id/retry',
    ]
    for (const path of paths) expect(routes).toContain(`'${path}'`)
    expect(routes).toContain('canManagePlatformAiContent(req.user)')
    expect(routes).toContain("manual_trade_review_forbidden")
    const review = read('server/routes/ai/manual-trade-review.js')
    expect(review).toContain('WHERE cases.id = ? AND cases.user_id = ?')
    expect(review).toContain('resolveAiTaskModel({ userId:job.user_id, strategyId:job.strategy_id, usage:\'review\' })')
    const worker = review.slice(review.indexOf('export async function runManualTradeReviewWorkerOnce'),
      review.indexOf('export async function recoverAbandonedManualTradeReviewJobs'))
    expect((worker.match(/await requestModel\(/g) || [])).toHaveLength(2)
    expect(worker).toContain("progress_stage = 'counterfactual_analysis'")
    expect(worker).toContain("progress_stage = 'outcome_review'")
    expect(worker).toContain("modelTaskDeadlines('manual_analysis'")
    expect(worker).toContain('job._taskDeadlineAtMs')
    expect(worker).toContain('counterfactualDeadline.attemptSafetyDeadlineUtcMs')
    expect(worker).toContain('outcomeDeadline.attemptSafetyDeadlineUtcMs')
    expect(worker).toContain('createModelTaskTracker')
    expect(worker).toContain('startManualTradeReviewLeaseHeartbeat')
    expect(review).toContain('manual_trade_review_counterfactual_immutable')
  })

  it('starts and stops the new worker without restoring the legacy trade-review worker', () => {
    const index = read('server/index.js')
    expect(index).toContain('startManualTradeReviewWorker')
    expect(index).toContain('stopManualTradeReviewWorker')
    expect(index).toContain("startManualTradeReviewWorker()")
    const aiIndex = read('server/routes/ai/index.js')
    expect(aiIndex).toContain('startManualTradeReviewWorker, stopManualTradeReviewWorker')
  })

  it('does not expose a path from single-trade review into platform experience', () => {
    const routes = read('server/routes/ai/index.js')
    const review = read('server/routes/ai/manual-trade-review.js')
    const experience = read('server/routes/ai/platform-experience.js')
    expect(routes).not.toContain('/ai/manual-trade-reviews/:id/experience-candidates')
    expect(review).not.toContain('createPlatformExperienceCandidatesFromManualReview')
    expect(experience).not.toContain('createPlatformExperienceCandidatesFromManualReview')
    expect(review).not.toContain('experience_candidates:')
    expect(review).toContain("const REVIEW_OUTPUT_VERSION = 'manual-trade-review-v2'")
    expect(review).toContain('counterfactualPrompt')
    expect(review).toContain('outcomeReviewPrompt')
  })

  it('keeps eligible-trade pagination on the Bridge snapshot cursor contract', () => {
    const evidence = read('server/routes/ai/manual-trade-evidence.js')
    expect(evidence).toContain('history_snapshot_id:result.history_snapshot_id')
    expect(evidence).toContain('next_cursor:result.next_cursor')
    expect(evidence).toContain('has_more:hasMore')
    expect(evidence).toContain("evidence:true")
    expect(evidence).not.toContain('(safePage - 1)')
    expect(evidence).toContain('outcomes.trading_account_id = ?')
    expect(evidence).toContain('JOIN signal_outcomes outcomes ON outcomes.signal_id = deliveries.signal_id')
  })
})
