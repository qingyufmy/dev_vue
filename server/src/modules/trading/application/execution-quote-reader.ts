import type { TerminalFactRoute } from './terminal-fact-route-guard.js'
export interface ExecutionQuoteScope { readonly route: TerminalFactRoute; readonly symbol: string; readonly maxAgeMs: number }
export interface ExecutionQuoteFacts {
  readonly accountId: string
  readonly symbol: string
  readonly bid: string
  readonly ask: string
  readonly revision: number
  readonly observedAt: string
}
export interface ExecutionQuoteReader {
  /** Returns only exact-route source-proven quotes with locks retained on the caller transaction. */
  read(scope: ExecutionQuoteScope): Promise<ExecutionQuoteFacts | null>
}
