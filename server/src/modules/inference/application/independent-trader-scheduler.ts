import type { TraderRun } from '../domain/inference.js'
import type { InferenceService } from './inference-service.js'

export interface IndependentTraderScheduleCandidate {
  subscriptionId: string
  subscriptionRevision: number
  userId: number
  tradingAccountId: string
  marketAnalysisId: string
  strategyId: string
  strategyVersionId: string
  symbol: string
}

export interface IndependentTraderScheduleStore {
  listCandidates(limit: number, afterSubscriptionId: string): Promise<IndependentTraderScheduleCandidate[]>
}

export function independentTraderSlot(now: Date) {
  const step = 5 * 60_000
  // Give the terminal/bridge a short window to persist the just-closed bar.
  return new Date(Math.floor((now.getTime() - 30_000) / step) * step).toISOString()
}

/**
 * Runs once per closed M5 slot through the existing trader request path. The
 * repository remains authoritative for background validity, inventory and
 * idempotency, so this poller cannot turn an expired background into an entry.
 */
export class IndependentTraderScheduler {
  private slot = ''
  private cursor = '0'
  private attempted = new Set<string>()
  constructor(private readonly schedules: IndependentTraderScheduleStore, private readonly inference: InferenceService,
    private readonly marketSessions?: { check(input: { userId: number; strategyId: string; strategyVersionId: string; symbol: string }): Promise<{ allowed: boolean }> }) {}

  async tick(now = new Date(), limit = 100) {
    const slot = independentTraderSlot(now)
    if (slot !== this.slot) { this.slot = slot; this.cursor = '0'; this.attempted.clear() }
    let candidates = await this.schedules.listCandidates(Math.min(Math.max(limit, 1), 500), this.cursor)
    if (candidates.length === 0 && this.cursor !== '0') {
      this.cursor = '0'
      candidates = await this.schedules.listCandidates(Math.min(Math.max(limit, 1), 500), this.cursor)
    }
    const runs: TraderRun[] = []
    const failures: Array<{ key: string; error: unknown }> = []
    for (const candidate of candidates) {
      this.cursor = candidate.subscriptionId
      const key = `${candidate.subscriptionId}:${slot}`
      if (this.attempted.has(key)) continue
      this.attempted.add(key)
      try {
        if (this.marketSessions && !(await this.marketSessions.check(candidate)).allowed) continue
        runs.push(await this.inference.requestAccountEvaluation(candidate.userId, {
          tradingAccountId: candidate.tradingAccountId,
          marketAnalysisId: candidate.marketAnalysisId,
          subscriptionId: candidate.subscriptionId,
          subscriptionRevision: candidate.subscriptionRevision,
          strategyId: candidate.strategyId,
          strategyVersionId: candidate.strategyVersionId,
        }, `independent-m5:${candidate.subscriptionId}:r${candidate.subscriptionRevision}:${candidate.marketAnalysisId}:${slot}`, now))
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        // No inventory to manage with an expired background is an expected
        // idle state, not a scheduler failure.
        if (code !== 'trader_analysis_expired' && code !== 'trader_no_actionable_context') failures.push({ key, error })
      }
    }
    return { runs, failures }
  }
}
