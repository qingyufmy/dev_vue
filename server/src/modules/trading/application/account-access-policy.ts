import {
  isPositiveDatabaseId, isValidUserId, utcMilliseconds, validOwnershipInterval,
  type AccountAccessPolicy, type AccountAccessRequest, type CurrentAccountAccessEvidence,
  type ExecutionAccountAccessEvidence, type OwnHistoryAccessEvidence, type PublishedAccountAccessEvidence,
} from '../domain/account-access.js'

export class EvidenceAccountAccessPolicy implements AccountAccessPolicy {
  canReadCurrentAccount(request: AccountAccessRequest, evidence: CurrentAccountAccessEvidence): boolean {
    if (!validRequest(request, 'full') || evidence.accountId !== request.accountId || evidence.accountDeleted !== false
      || !sameRevision(evidence.ownershipRevision, evidence.expectedOwnershipRevision)) return false
    const { grant, interval } = evidence
    if (!grant || !interval || !validOwnershipInterval(interval)) return false
    return grant.userId === request.userId && grant.accountId === request.accountId && grant.role === 'owner'
      && grant.revokedAtUtc === null && grant.intervalId === interval.id
      && grant.grantedAtUtc === interval.startedAtUtc
      && interval.userId === request.userId && interval.accountId === request.accountId && interval.role === 'owner'
      && interval.endedAtUtc === null && utcMilliseconds(interval.startedAtUtc) <= utcMilliseconds(request.nowUtc)
      && utcMilliseconds(grant.grantedAtUtc) <= utcMilliseconds(request.nowUtc)
  }

  canReadOwnHistory(request: AccountAccessRequest, evidence: OwnHistoryAccessEvidence): boolean {
    if (!validRequest(request, 'full') || !opaqueReference(evidence.recordId)
      || evidence.accountId !== request.accountId || evidence.userId !== request.userId) return false
    const from = utcMilliseconds(evidence.firstOccurredAtUtc)
    const to = utcMilliseconds(evidence.lastOccurredAtUtc)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to > utcMilliseconds(request.nowUtc)) return false
    const attribution = evidence.attribution
    if (attribution.kind === 'system') {
      return opaqueReference(attribution.referenceId) && attribution.userId === request.userId && attribution.accountId === request.accountId
    }
    if (attribution.kind !== 'ownership_interval') return false
    const interval = attribution.interval
    if (!validOwnershipInterval(interval) || interval.role !== 'owner'
      || interval.userId !== request.userId || interval.accountId !== request.accountId) return false
    return from >= utcMilliseconds(interval.startedAtUtc)
      && (interval.endedAtUtc === null || to < utcMilliseconds(interval.endedAtUtc))
  }

  canExecute(request: AccountAccessRequest, evidence: ExecutionAccountAccessEvidence): boolean {
    if (!this.canReadCurrentAccount(request, evidence.current) || evidence.connectionPaused !== false
      || evidence.tradingEnabled !== true || evidence.membershipAllowsTrading !== true || evidence.globalHalted !== false) return false
    const { route, expectedRoute } = evidence
    return route !== null && route.userId === request.userId && route.accountId === request.accountId
      && opaqueReference(route.profileId) && route.profileId === expectedRoute.profileId
      && opaqueReference(route.instanceId) && route.instanceId === expectedRoute.instanceId
      && sameRevision(route.epoch, expectedRoute.epoch)
      && utcMilliseconds(route.leaseExpiresAtUtc) > utcMilliseconds(request.nowUtc)
  }

  canObservePublished(request: AccountAccessRequest, evidence: PublishedAccountAccessEvidence): boolean {
    if (!validRequest(request, 'observer') || evidence.accountId !== request.accountId
      || !isPositiveDatabaseId(evidence.channelId) || evidence.channelId !== evidence.expectedChannelId
      || !isPositiveDatabaseId(evidence.sourceId) || evidence.sourceId !== evidence.expectedSourceId
      || !sameRevision(evidence.sourceRevision, evidence.expectedSourceRevision)
      || evidence.sourceActive !== true || evidence.sourceReady !== true || evidence.channelActive !== true || evidence.published !== true
      || !['account.metrics', 'market.quote', 'market.candle', 'positions', 'pending_orders'].includes(evidence.resource)
      || !['all', 'plus', 'pro', 'assigned'].includes(evidence.audience)
      || !(utcMilliseconds(evidence.authorizationExpiresAtUtc) > utcMilliseconds(request.nowUtc))) return false
    if (evidence.audience === 'all') return true
    if ((evidence.audience === 'plus' || evidence.audience === 'pro') && evidence.effectivePlan === evidence.audience) return true
    const grant = evidence.grant
    return grant !== null && grant.userId === request.userId && grant.channelId === evidence.channelId
      && grant.revokedAtUtc === null && utcMilliseconds(grant.grantedAtUtc) <= utcMilliseconds(request.nowUtc)
  }
}

function validRequest(request: AccountAccessRequest, mode: AccountAccessRequest['mode']): boolean {
  return request.active === true && request.mode === mode && isValidUserId(request.userId)
    && isPositiveDatabaseId(request.accountId) && Number.isFinite(utcMilliseconds(request.nowUtc))
}

function sameRevision(actual: string, expected: string): boolean {
  return isPositiveDatabaseId(actual) && actual === expected
}

function opaqueReference(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,191}$/.test(value)
}
