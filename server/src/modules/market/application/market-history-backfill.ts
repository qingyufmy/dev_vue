import type { MarketSourceScope, MarketSourceState } from '../domain/market-source.js'

export const HISTORY_PERIODS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const
export type HistoryPeriod = typeof HISTORY_PERIODS[number]
const MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }
// Keep a candle page below the MT4 pipe's 64 KiB JSON string limit.
const PAGE_SIZE = 200
export interface HistoryProgress {
  generation: number; source: string; anchor: number; before: number; count: number; pages: number; stopAt: number | null
  status: 'collecting' | 'complete' | 'insufficient'; retryAt: number
}
export interface HistoryDemand extends MarketSourceScope { timeframe: HistoryPeriod }
export interface MarketHistoryPorts {
  demands(): Promise<HistoryDemand[]>
  select(scope: MarketSourceScope): Promise<MarketSourceState>
  current(scope: MarketSourceScope, state: MarketSourceState): Promise<boolean>
  progress(demand: HistoryDemand): Promise<HistoryProgress | null>
  save(demand: HistoryDemand, progress: HistoryProgress): Promise<void>
  collect(demand: HistoryDemand, state: MarketSourceState, before: number, limit: number): Promise<number>
  changed(demand: HistoryDemand, state: MarketSourceState): Promise<void>
}

/** One bounded page per tick. Calendar gaps are queried, never filled with invented bars. */
export class MarketHistoryBackfill {
  private cursor = 0
  private running = false
  private stopped = false
  constructor(private readonly ports: MarketHistoryPorts, private readonly now = Date.now) {}
  close() { this.stopped = true }
  async tick() {
    if (this.running || this.stopped) return
    this.running = true
    try {
      const demands = await this.ports.demands()
      if (!demands.length || this.stopped) return
      const demand = demands[this.cursor++ % demands.length]!
      const state = await this.ports.select(demand)
      if (!state.source || !state.resolvedSymbol || state.failures || this.stopped) return
      const now = this.now()
      let progress = await this.ports.progress(demand)
      const source = `${state.source.ownerUserId}:${state.source.accountId}:${state.resolvedSymbol}`
      if (!progress || progress.source !== source) {
        progress = { generation: state.generation, source, anchor: now, before: now, count: 0, pages: 0, stopAt: null, status: 'collecting', retryAt: 0 }
      }
      if (progress.generation !== state.generation) progress = { ...progress, generation: state.generation, retryAt: 0 }
      if (progress.retryAt > now) return
      // Recheck recent terminal history after completion to repair missed live bars.
      if (progress.status !== 'collecting') {
        progress = { ...progress, stopAt: progress.status === 'complete' ? progress.anchor : null,
          anchor: now, before: now, count: 0, pages: 0, status: 'collecting' }
      }
      try {
        const count = await this.ports.collect(demand, state, progress.before, PAGE_SIZE)
        if (!await this.ports.current(demand, state) || this.stopped) return
        const before = progress.before - MINUTES[demand.timeframe] * 60_000 * (PAGE_SIZE - 1)
        const total = progress.count + count, pages = progress.pages + 1
        const status = progress.stopAt !== null ? before <= progress.stopAt ? 'complete' : pages >= 24 ? 'insufficient' : 'collecting'
          : total >= 2000 ? 'complete' : pages >= 24 || before <= 0 ? 'insufficient' : 'collecting'
        await this.ports.save(demand, { ...progress, before, count: total, pages, status,
          retryAt: status === 'complete' ? now + 60 * 60_000 : status === 'insufficient' ? now + 6 * 60 * 60_000 : 0 })
        if (count > 0) await this.ports.changed(demand, state)
      } catch (error) {
        await this.ports.save(demand, { ...progress, retryAt: now + 30_000 })
        throw error
      }
    } finally { this.running = false }
  }
}
