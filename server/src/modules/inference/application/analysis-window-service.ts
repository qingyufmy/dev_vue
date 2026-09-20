import { evaluateSubscriptionWindow, type SubscriptionWindowClock, type AnalysisWindowReader } from '../../strategies/index.js'
import type { AnalysisWindowGuard } from './analysis-window-guard.js'
import { InferenceError, type AnalysisRun } from '../domain/inference.js'

export class AnalysisWindowService implements AnalysisWindowGuard {
  constructor(private readonly windows: AnalysisWindowReader,
    private readonly readClock: (accountId: string, userId: number) => Promise<SubscriptionWindowClock | null>) {}

  async assertAllowed(run: AnalysisRun, now: Date) {
    if (run.trigger !== 'scheduled') return
    if (!run.marketSourceAccountId) throw new InferenceError('analysis_schedule_unavailable', 409)
    const rows = await this.windows.list({ userId: run.userId, accountId: run.marketSourceAccountId,
      strategyId: run.strategyId, strategyVersionId: run.strategyVersionId, symbol: run.symbol })
    let clock: SubscriptionWindowClock | null = null, clockRead = false
    for (const row of rows) {
      let decision = evaluateSubscriptionWindow(row.window, row.timezone, now, null)
      if (decision.reason === 'clock_unverified') {
        if (!clockRead) { clock = await this.readClock(run.marketSourceAccountId, run.userId); clockRead = true }
        decision = evaluateSubscriptionWindow(row.window, row.timezone, now, clock)
      }
      if (decision.inferenceAllowed) return
    }
    throw new InferenceError('analysis_schedule_closed', 409)
  }
}
