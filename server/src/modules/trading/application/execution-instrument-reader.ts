import type { TerminalFactRoute } from './terminal-fact-route-guard.js'
export interface ExecutionInstrumentScope {
  readonly route: TerminalFactRoute
  readonly symbol: string
  readonly maxAgeMs: number
  readonly maxInstrumentAgeMs: number
}
export interface ExecutionInstrumentFacts {
  readonly accountId: string
  readonly symbol: string
  readonly point: string
  readonly tickSize: string
  readonly volumeMin?: string
  readonly volumeMax?: string
  readonly volumeStep?: string
  readonly tradeEnabled: boolean
  readonly revision: number
  readonly observedAt: string
}
export interface ExecutionInstrumentReader { read(scope: ExecutionInstrumentScope): Promise<ExecutionInstrumentFacts | null> }
