import type { TerminalFactRoute } from './terminal-fact-route-guard.js'

export interface ExecutionPositionReadScope {
  readonly route: TerminalFactRoute
  readonly ticket: string
  readonly positionIdentifier: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly revision: number
  readonly maxAgeMs: number
}
export interface ExecutionPositionSnapshot {
  readonly accountId: string
  readonly ticket: string
  readonly positionIdentifier: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly volume: string
  readonly revision: number
  readonly observedAt: string
}
export interface ExecutionPositionReader {
  /** Caller transaction owns authorization and collection locks until registration commits. */
  read(scope: ExecutionPositionReadScope): Promise<ExecutionPositionSnapshot | null>
}

export interface ExecutionPositionCollectionScope {
  readonly route: TerminalFactRoute
  readonly maxAgeMs: number
  readonly revision?: number
}
export interface ExecutionPositionCollection {
  readonly accountId: string
  readonly revision: number
  readonly observedAt: string
  readonly positions: readonly (Omit<ExecutionPositionSnapshot, 'revision' | 'observedAt' | 'positionIdentifier'> & { readonly positionIdentifier: string | null
    /** Undefined is unknown/invalid; null is an explicit terminal report of no protection. */
    readonly stopLoss?: string | null
    readonly takeProfit?: string | null
  })[]
}
export interface ExecutionPositionCollectionReader {
  /** An empty validated collection proves absence; null means the collection or authorization is unavailable. */
  read(scope: ExecutionPositionCollectionScope): Promise<ExecutionPositionCollection | null>
}
