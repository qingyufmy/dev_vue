import type { AnalysisRun } from '../domain/inference.js'
import type { InferenceService } from './inference-service.js'
import { evaluateSubscriptionWindow, type SubscriptionWindowClock } from '../../strategies/index.js'

import type { AnalysisScheduleStore, DueAnalysisSchedule } from '../../strategies/index.js'
export type { AnalysisScheduleStore as AnalysisScheduleRepository, DueAnalysisSchedule } from '../../strategies/index.js'

export function scheduleSlotUtc(now: Date, cadenceSeconds: number) {
  if (!Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 60) throw new Error('analysis_cadence_invalid')
  return new Date(Math.floor(now.getTime() / (cadenceSeconds * 1000)) * cadenceSeconds * 1000).toISOString()
}

export function nextScheduleSlotUtc(now: Date, cadenceSeconds: number) {
  return new Date(Date.parse(scheduleSlotUtc(now, cadenceSeconds)) + cadenceSeconds * 1000).toISOString()
}

export class AnalysisScheduler {
  constructor(private readonly schedules: AnalysisScheduleStore, private readonly inference: InferenceService,
    private readonly readClock: (accountId: string, userId: number) => Promise<SubscriptionWindowClock | null> = async () => null) {}

  async tick(now = new Date(), limit = 100) {
    const due = await this.schedules.listDue(now.toISOString(), Math.min(Math.max(limit, 1), 500))
    const groups = new Map<string, DueAnalysisSchedule[]>()
    const failures: Array<{ key: string; error: unknown }> = []
    for (const item of due) {
      try {
        // Validate first without I/O; disabled schedules do not need a clock.
        let decision = evaluateSubscriptionWindow(item.receiveWindow, item.receiveTimezone, now, null)
        if (decision.reason === 'clock_unverified') decision = evaluateSubscriptionWindow(item.receiveWindow, item.receiveTimezone, now,
          await this.readClock(item.marketSourceAccountId, item.userId))
        if (!decision.inferenceAllowed) {
          await this.schedules.advance(item.subscriptionId, item.nextDueAt, nextScheduleSlotUtc(now, item.cadenceSeconds))
          continue
        }
      } catch (error) {
        failures.push({ key: item.subscriptionId, error })
        continue
      }
      const slot = scheduleSlotUtc(now, item.cadenceSeconds)
      const key = `${item.userId}:${item.strategyVersionId}:${item.symbol}:${slot}`
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }

    const runs: AnalysisRun[] = []
    for (const [key, group] of groups) {
      const first = [...group].sort((left, right) => left.marketSourceAccountId.localeCompare(right.marketSourceAccountId))[0]!
      try {
        const slot = scheduleSlotUtc(now, first.cadenceSeconds)
        const run = await this.inference.requestScheduledAnalysis({
          userId: first.userId, strategyId: first.strategyId, strategyVersionId: first.strategyVersionId,
          symbol: first.symbol, marketSourceAccountId: first.marketSourceAccountId, scheduleSlot: slot,
        }, now)
        runs.push(run)
        await Promise.all(group.map(item => this.schedules.advance(item.subscriptionId, item.nextDueAt, nextScheduleSlotUtc(now, item.cadenceSeconds))))
      } catch (error) {
        failures.push({ key, error })
      }
    }
    return { runs, failures }
  }
}
