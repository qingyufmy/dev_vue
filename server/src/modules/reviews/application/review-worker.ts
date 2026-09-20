import { createHash, randomUUID } from 'node:crypto'
import { ReviewError, assertReviewContent, reviewContentFromWire } from '../domain/review.js'
import type { ReviewJobClaim, ReviewWorkerRepository } from './review-ports.js'

export interface ReviewModelGateway {
  readonly profileId: string
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxAttempts: number
  invoke(messages: Array<{ role: 'system' | 'user'; content: string }>, signal: AbortSignal): Promise<{ value: unknown; usage: Record<string, unknown> | null }>
}

export interface ReviewModelGatewayResolver {
  resolve(claim: ReviewJobClaim): Promise<ReviewModelGateway>
}

// Covers the bounded worst case of three 10-minute provider attempts plus
// resolution, validation and persistence overhead. A crashed worker is still
// reclaimed deterministically after this lease and fenced before write-back.
const REVIEW_JOB_LEASE_MS = 35 * 60_000

export class ReviewWorker {
  constructor(
    private readonly repository: ReviewWorkerRepository,
    private readonly models: ReviewModelGatewayResolver,
    private readonly workerId: string,
  ) {}

  async process(jobId: string, now = new Date()) {
    const claimedAt = now.toISOString()
    const claim = await this.repository.claimJob(jobId, this.workerId, claimedAt, new Date(now.getTime() + REVIEW_JOB_LEASE_MS).toISOString())
    if (!claim) return { status: 'ignored' as const }
    let gateway: ReviewModelGateway
    try { gateway = await this.models.resolve(claim) }
    catch (error) {
      const code = errorCode(error, 'review_model_unavailable')
      await this.repository.failJob({ claim, errorCode: code, now: now.toISOString() })
      return { status: 'failed' as const, code }
    }
    const attempts = Math.min(Math.max(Math.trunc(gateway.maxAttempts || 1), 1), 3)
    if (claim.nextAttemptNumber > attempts) {
      await this.repository.failJob({ claim, errorCode: 'review_attempts_exhausted', now: new Date().toISOString() })
      return { status: 'failed' as const, code: 'review_attempts_exhausted' }
    }
    for (let attemptNumber = claim.nextAttemptNumber; attemptNumber <= attempts; attemptNumber += 1) {
      const attemptId = randomUUID(); const attemptedAt = new Date().toISOString()
      await this.repository.startModelAttempt({ claim, attemptId, attemptNumber, profileId: gateway.profileId, provider: gateway.provider, model: gateway.model, now: attemptedAt })
      try {
        const output = await gateway.invoke(messages(claim), AbortSignal.timeout(Math.min(Math.max(gateway.timeoutMs, 1_000), 600_000)))
        const normalized = reviewContentFromWire(output.value)
        assertReviewContent(normalized)
        if (normalized.evidenceRefs.some(ref => !claim.allowedEvidenceRefs.includes(ref))) throw Object.assign(new Error('review_evidence_reference_invalid'), { status: 'contract_invalid', retryable: false })
        if (normalized.memoryCandidates.some(candidate => !claim.allowedStrategyIds.includes(candidate.strategyId))) throw Object.assign(new Error('review_memory_strategy_invalid'), { status: 'contract_invalid', retryable: false })
        const completed = await this.repository.completeJob({ claim, attemptId, content: normalized, responseHash: sha256(output.value), usage: output.usage, now: new Date().toISOString() })
        return { status: 'succeeded' as const, ...completed }
      } catch (error) {
        if (error instanceof ReviewError && error.code === 'review_commit_unknown') throw error
        const failure = modelFailure(error); const final = !failure.retryable || attemptNumber >= attempts
        await this.repository.failModelAttempt({ claim, attemptId, status: failure.status, errorCode: failure.code, final, now: new Date().toISOString() })
        if (final) return { status: 'failed' as const, code: failure.code }
      }
    }
    return { status: 'failed' as const, code: 'review_attempts_exhausted' }
  }
}

function messages(claim: ReviewJobClaim): Array<{ role: 'system' | 'user'; content: string }> {
  const strategyContext = [claim.analysisPrompt ? `分析策略：\n${claim.analysisPrompt}` : '', claim.traderPrompt ? `交易执行策略：\n${claim.traderPrompt}` : ''].filter(Boolean).join('\n\n')
  return [
    { role: 'system', content: '你是交易复盘师。只评价冻结证据中分析、交易决策、确定性风控、终端执行和结果各自表现；区分事前决策质量与事后盈亏。漏单和误报只能标为反事实候选，单一样本不能判定策略缺陷。用户自述不是已验证事实。不得修改策略、风控或执行任何交易。' },
    { role: 'system', content: strategyContext || '本复盘没有可用策略正文，只能给出证据不足结论。' },
    { role: 'system', content: reviewOutputContract },
    { role: 'user', content: JSON.stringify({ evidence_revision: claim.evidenceRevision, evidence_sha256: claim.evidenceHash, allowed_evidence_refs: claim.allowedEvidenceRefs, evidence: claim.evidence }) },
  ]
}

function modelFailure(error: unknown) {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; status?: unknown; retryable?: unknown }
    const code = typeof value.code === 'string' ? value.code : typeof value.message === 'string' && /^[a-z0-9_]{3,128}$/.test(value.message) ? value.message : 'review_model_failed'
    const status: 'failed' | 'timed_out' | 'contract_invalid' = value.status === 'timed_out' ? 'timed_out' : value.status === 'contract_invalid' || value.status === 422 ? 'contract_invalid' : 'failed'
    return { code, status, retryable: value.retryable === true }
  }
  return { code: 'review_model_failed', status: 'failed' as const, retryable: false }
}
function errorCode(error: unknown, fallback: string) { const value = error instanceof Error ? error.message : ''; return /^[a-z0-9_]{3,128}$/.test(value) ? value : fallback }
function sha256(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

const reviewOutputContract = `只返回 JSON 对象，不要 Markdown。字段：schema_version 固定 review.v4.1；conclusion 为 effective|mixed|ineffective|insufficient_evidence|manual_trade_reviewed；headline；summary；metrics(net_profit,trade_count,win_rate_percent,profit_factor)；trade_episodes；roles(analyst,trader,risk,execution，每项 assessment/summary/evidence_refs)；counterexamples(kind/title/summary/evidence_refs/status)；memory_candidates(strategy_id/memory_key/update_kind/title/content/evidence_refs)，其中 memory_key 是同类经验跨复盘稳定复用的小写标识；evidence_refs；full_analysis_text。所有 evidence_refs 必须来自输入证据。经验只生成待人工确认候选，不得写成确定规则。`
