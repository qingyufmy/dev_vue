import type { TerminalFactRoute } from './terminal-fact-route-guard.js'
import type { AccountClock } from '../domain/account-clock.js'

export interface ExecutionAccountScope { readonly route: TerminalFactRoute; readonly maxAgeMs: number }
export interface ExecutionAccountFacts {
  readonly accountId: string
  readonly account: AccountClock & { readonly tradePermission: boolean; readonly revision: number; readonly observedAt: string }
}
export interface ExecutionAccountReader {
  /** Caller retains authorization, session and projection locks until its transaction commits. */
  read(scope: ExecutionAccountScope): Promise<ExecutionAccountFacts | null>
}
