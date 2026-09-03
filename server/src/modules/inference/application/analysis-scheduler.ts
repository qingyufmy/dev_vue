import type { AnalysisRun } from '../domain/inference.js'
import type { InferenceService } from './inference-service.js'

export interface DueAnalysisSchedule {
  subscriptionId: string
  userId: number
  marketSourceAccountId: string
  strategyId: string
  strategyVersionId: string
  symbol: string
  cadenceSeconds: number
  nextDueAt: string
}

export interface AnalysisScheduleRepository {
  listDue(now: string, limit: number): Promise<DueAnalysisSchedule[]>
  advance(subscriptionId: string, expectedDueAt: string, nextDueAt: string): Promise<boolean>
}

export function scheduleSlotUtc(now: Date, cadenceSeconds: number) {
  if (!Number.isSafeInteger(cadenceSeconds) || cadenceSeconds < 60) throw new Error('analysis_cadence_invalid')
  return new Date(Math.floor(now.getTime() / (cadenceSeconds * 1000)) * cadenceSeconds * 1000).toISOString()
}

export function nextScheduleSlotUtc(now: Date, cadenceSeconds: number) {
  return new Date(Date.parse(scheduleSlotUtc(now, cadenceSeconds)) + cadenceSeconds * 1000).toISOString()
}

export class AnalysisScheduler {
  constructor(private readonly schedules: AnalysisScheduleRepository, private readonly inference: InferenceService) {}

  async tick(now = new Date(), limit = 100) {
    const due = await this.schedules.listDue(now.toISOString(), Math.min(Math.max(limit, 1), 500))
    const groups = new Map<string, DueAnalysisSchedule[]>()
    for (const item of due) {
      const slot = scheduleSlotUtc(now, item.cadenceSeconds)
      const key = `${item.userId}:${item.strategyVersionId}:${item.symbol}:${slot}`
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }

    const runs: AnalysisRun[] = []
    const failures: Array<{ key: string; error: unknown }> = []
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
