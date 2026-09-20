import type { ObserverChannelSummary } from '../domain/trading.js'

export const OBSERVER_AUTHORIZATION_TTL_MS = 30_000

// Server-derived, short-lived proof; never accept these fields from a browser.
export interface ObserverAuthorization {
  userId: number
  channelId: string
  sourceId: string
  sourceRevision: string
  channelRevision: string
  accessRevision: string
  userTokenVersion: number
  accountId: string
  ownershipRevision: string
  operatorUserId: number
  displayName: string
  expiresAtUtc: string
}

export interface ObserverAccessReader {
  list(userId: number): Promise<ObserverChannelSummary[]>
  authorize(userId: number, channelId: string, accountId?: string): Promise<ObserverAuthorization | null>
}

/** Current publication access for the exact market source frozen by an analysis. */
export interface StrategyObserverAccessReader {
  read(scope: { userId: number; sourceAccountId: string; analysisStrategyId: string }): Promise<{
    analysisStrategyId: string
    authorization: ObserverAuthorization
  } | null>
}

export function sameObserverAuthorization(left: ObserverAuthorization, right: ObserverAuthorization): boolean {
  return left.userId === right.userId && left.channelId === right.channelId
    && left.sourceId === right.sourceId && left.sourceRevision === right.sourceRevision
    && left.channelRevision === right.channelRevision && left.accessRevision === right.accessRevision
    && left.userTokenVersion === right.userTokenVersion && left.accountId === right.accountId
    && left.ownershipRevision === right.ownershipRevision
    && left.operatorUserId === right.operatorUserId
}
