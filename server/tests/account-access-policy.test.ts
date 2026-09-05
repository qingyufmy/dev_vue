import { describe, expect, it } from 'vitest'
import { EvidenceAccountAccessPolicy } from '../src/modules/trading/application/account-access-policy.js'
import {
  validateOwnershipTimeline, type AccountAccessRequest, type CurrentAccountAccessEvidence,
  type ExecutionAccountAccessEvidence, type OwnHistoryAccessEvidence, type OwnershipInterval,
  type PublishedAccountAccessEvidence,
} from '../src/modules/trading/domain/account-access.js'

const policy = new EvidenceAccountAccessPolicy()
const time = (hour: number) => `2026-09-05T${String(hour).padStart(2, '0')}:00:00.000Z`
const request = (overrides: Partial<AccountAccessRequest> = {}): AccountAccessRequest => ({
  userId: 1, active: true, mode: 'full', accountId: '9007199254740993', nowUtc: time(12), ...overrides,
})
function interval(n = 1, overrides: Partial<OwnershipInterval> = {}): OwnershipInterval {
  return { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, userId: 1,
    accountId: request().accountId, role: 'owner', startedAtUtc: time(8), endedAtUtc: null,
    originKind: 'runtime', originRef: `operation:${n}`, ...overrides }
}
function current(): CurrentAccountAccessEvidence {
  const i = interval()
  return { accountId: i.accountId, accountDeleted: false, ownershipRevision: '3', expectedOwnershipRevision: '3',
    grant: { userId: 1, accountId: i.accountId, role: 'owner', intervalId: i.id, grantedAtUtc: i.startedAtUtc, revokedAtUtc: null }, interval: i }
}
function execution(): ExecutionAccountAccessEvidence {
  return { current: current(), connectionPaused: false, tradingEnabled: true, membershipAllowsTrading: true, globalHalted: false,
    expectedRoute: { profileId: 'profile-a', instanceId: 'instance-a', epoch: '8' },
    route: { userId: 1, accountId: request().accountId, profileId: 'profile-a', instanceId: 'instance-a', epoch: '8', leaseExpiresAtUtc: time(13) } }
}
function history(): OwnHistoryAccessEvidence {
  return { recordId: 'trade-1', accountId: request().accountId, userId: 1, firstOccurredAtUtc: time(8), lastOccurredAtUtc: time(9),
    attribution: { kind: 'ownership_interval', interval: interval(1, { endedAtUtc: time(10) }) } }
}
function published(): PublishedAccountAccessEvidence {
  return { accountId: request().accountId, channelId: '2', expectedChannelId: '2', sourceId: '3', expectedSourceId: '3',
    sourceRevision: '9', expectedSourceRevision: '9', sourceActive: true, sourceReady: true, channelActive: true, published: true,
    resource: 'market.quote', audience: 'all', effectivePlan: 'free', authorizationExpiresAtUtc: time(13), grant: null }
}

describe('account ownership intervals (pure contract, no database)', () => {
  it('retains A to B to A as three distinct intervals; validates unordered input without mutating it', () => {
    const a = interval(1, { endedAtUtc: time(9) })
    const b = interval(2, { userId: 2, startedAtUtc: time(9), endedAtUtc: time(10) })
    const again = interval(3, { startedAtUtc: time(10) })
    const records = Object.freeze([again, b, a])
    expect(validateOwnershipTimeline(records)).toEqual({ ok: true })
    expect(records.map(row => row.id)).toEqual([again.id, b.id, a.id])
    expect(validateOwnershipTimeline([a, { ...again, id: a.id }])).toEqual({ ok: false, reason: 'duplicate_interval' })
    expect(validateOwnershipTimeline([a, { ...again, originRef: a.originRef }])).toEqual({ ok: false, reason: 'duplicate_origin' })
  })
  it('blocks overlapping closed intervals and distinct concurrent open owners', () => {
    expect(validateOwnershipTimeline([interval(), interval(2, { userId: 2, startedAtUtc: time(9) })]))
      .toEqual({ ok: false, reason: 'owner_overlap' })
    expect(validateOwnershipTimeline([interval(1, { endedAtUtc: time(11) }), interval(2, { startedAtUtc: time(9), endedAtUtc: time(10) })]))
      .toEqual({ ok: false, reason: 'owner_overlap' })
  })
  it('allows multiple accounts for one user and separate read-only source intervals', () => {
    expect(validateOwnershipTimeline([interval(), interval(2, { accountId: '9007199254740994' }),
      interval(3, { userId: 2, role: 'observer_source' })])).toEqual({ ok: true })
  })
  it('preserves zero-length historical intervals but grants them no time range', () => {
    expect(validateOwnershipTimeline([interval(), interval(2, { startedAtUtc: time(9), endedAtUtc: time(9) })])).toEqual({ ok: true })
    const e = history()
    e.attribution = { kind: 'ownership_interval', interval: interval(2, { endedAtUtc: time(8) }) }
    expect(policy.canReadOwnHistory(request(), e)).toBe(false)
  })
  it.each([
    { endedAtUtc: time(7) }, { startedAtUtc: '2026-09-05 08:00:00' }, { endedAtUtc: '2026-02-30T09:00:00.000Z' },
    { startedAtUtc: '2026-09-05T08:00:00.000+00:00' }, { accountId: '18446744073709551616' },
    { userId: 0 }, { userId: 1.1 }, { id: 'not-an-interval-id' }, { originRef: '' }, { startedAtUtc: '0000-01-01T08:00:00.000Z' },
  ])('rejects malformed or unproven interval values: %j', overrides => {
    expect(validateOwnershipTimeline([interval(1, overrides)])).toEqual({ ok: false, reason: 'invalid_interval' })
  })
})

describe('separate server-side access purposes (not wired to endpoints in P2)', () => {
  it('allows current ownership without a live route, but not execution while offline', () => {
    expect(policy.canReadCurrentAccount(request(), current())).toBe(true)
    expect(policy.canExecute(request(), { ...execution(), route: null })).toBe(false)
    expect(policy.canExecute(request(), execution())).toBe(true)
  })
  it('fails closed on unconverted grants, stale ownership and mismatched ownership evidence', () => {
    const base = current()
    const bad: CurrentAccountAccessEvidence[] = [
      { ...base, grant: null }, { ...base, interval: null }, { ...base, ownershipRevision: '4' }, { ...base, accountDeleted: true },
      { ...base, grant: { ...base.grant!, intervalId: null } },
      { ...base, grant: { ...base.grant!, intervalId: interval(2).id } },
      { ...base, grant: { ...base.grant!, grantedAtUtc: time(7) } },
      { ...base, grant: { ...base.grant!, revokedAtUtc: time(9) } },
      { ...base, interval: interval(1, { userId: 2 }) }, { ...base, interval: interval(1, { accountId: '2' }) },
      { ...base, interval: interval(1, { endedAtUtc: time(10) }) },
      { ...base, interval: interval(1, { role: 'observer_source' }) },
      { ...base, grant: { ...base.grant!, grantedAtUtc: time(13) }, interval: interval(1, { startedAtUtc: time(13) }) },
    ]
    for (const evidence of bad) expect(policy.canReadCurrentAccount(request(), evidence)).toBe(false)
  })
  it('keeps the former owner history readable without granting the new owner those records', () => {
    expect(policy.canReadOwnHistory(request(), history())).toBe(true)
    expect(policy.canReadOwnHistory(request({ userId: 2 }), history())).toBe(false)
    expect(policy.canReadOwnHistory(request(), { ...history(), userId: 2 })).toBe(false)
    expect(policy.canReadOwnHistory(request(), { ...history(), attribution: { kind: 'unresolved' } })).toBe(false)
    // A system-attributed record requires immutable reference/user/account agreement, not current ownership.
    const e: OwnHistoryAccessEvidence = { ...history(), attribution: { kind: 'system', referenceId: 'operation-1', userId: 1, accountId: request().accountId } }
    expect(policy.canReadOwnHistory(request(), e)).toBe(true)
    expect(policy.canReadOwnHistory(request(), { ...e, attribution: { kind: 'system', referenceId: 'operation-1', userId: 2, accountId: e.accountId } })).toBe(false)
  })
  it('rejects records spanning ownership boundaries, exactly at an excluded end, or in the future', () => {
    expect(policy.canReadOwnHistory(request(), { ...history(), firstOccurredAtUtc: time(7) })).toBe(false)
    expect(policy.canReadOwnHistory(request(), { ...history(), lastOccurredAtUtc: time(10) })).toBe(false)
    expect(policy.canReadOwnHistory(request(), { ...history(), lastOccurredAtUtc: time(11) })).toBe(false)
    expect(policy.canReadOwnHistory(request(), { ...history(), firstOccurredAtUtc: time(10) })).toBe(false)
    expect(policy.canReadOwnHistory(request(), { ...history(), lastOccurredAtUtc: time(13) })).toBe(false)
  })
  it('rejects old epochs, wrong routes, expired leases, pauses and unavailable execution permissions', () => {
    const base = execution()
    const bad: ExecutionAccountAccessEvidence[] = [
      { ...base, connectionPaused: true }, { ...base, tradingEnabled: false }, { ...base, membershipAllowsTrading: false }, { ...base, globalHalted: true },
      { ...base, route: { ...base.route!, userId: 2 } }, { ...base, route: { ...base.route!, accountId: '9007199254740994' } },
      { ...base, route: { ...base.route!, profileId: 'other' } }, { ...base, route: { ...base.route!, instanceId: 'other' } },
      { ...base, route: { ...base.route!, epoch: '9' } }, { ...base, route: { ...base.route!, leaseExpiresAtUtc: time(12) } },
    ]
    for (const e of bad) expect(policy.canExecute(request(), e)).toBe(false)
  })
  it('keeps full/observer/blocked scopes separate and denies inactive or invalid subjects', () => {
    for (const r of [request({ active: false }), request({ userId: 0 }), request({ accountId: '0' }), request({ nowUtc: 'invalid' }), request({ mode: 'blocked' })]) {
      expect(policy.canReadCurrentAccount(r, current())).toBe(false)
      expect(policy.canReadOwnHistory(r, history())).toBe(false)
      expect(policy.canExecute(r, execution())).toBe(false)
      expect(policy.canObservePublished(r, published())).toBe(false)
    }
    expect(policy.canReadOwnHistory(request({ mode: 'observer' }), history())).toBe(false)
    expect(policy.canExecute(request({ mode: 'observer' }), execution())).toBe(false)
    expect(policy.canObservePublished(request(), published())).toBe(false)
  })
  it('applies published audience rules without implicitly making pro inherit plus', () => {
    const r = request({ mode: 'observer' })
    expect(policy.canObservePublished(r, published())).toBe(true)
    expect(policy.canObservePublished(r, { ...published(), audience: 'plus', effectivePlan: 'pro' })).toBe(false)
    expect(policy.canObservePublished(r, { ...published(), audience: 'plus', effectivePlan: 'plus' })).toBe(true)
    expect(policy.canObservePublished(r, { ...published(), audience: 'assigned', effectivePlan: 'assigned' })).toBe(false)
    const grant = { userId: 1, channelId: '2', grantedAtUtc: time(8), revokedAtUtc: null }
    expect(policy.canObservePublished(r, { ...published(), audience: 'assigned', grant })).toBe(true)
    for (const change of [{ userId: 2 }, { channelId: '3' }, { grantedAtUtc: time(13) }, { revokedAtUtc: time(9) }]) {
      expect(policy.canObservePublished(r, { ...published(), audience: 'assigned', grant: { ...grant, ...change } })).toBe(false)
    }
  })
  it('denies inactive, stale, private or unpublished observer content', () => {
    const base = published()
    const bad: PublishedAccountAccessEvidence[] = [
      { ...base, sourceActive: false }, { ...base, sourceReady: false }, { ...base, channelActive: false }, { ...base, published: false },
      { ...base, expectedSourceRevision: '10' }, { ...base, expectedChannelId: '9' }, { ...base, expectedSourceId: '4' },
      { ...base, authorizationExpiresAtUtc: time(12) }, { ...base, accountId: '9007199254740994' },
    ]
    for (const e of bad) expect(policy.canObservePublished(request({ mode: 'observer' }), e)).toBe(false)
    // Simulates invalid data reaching the internal port; it must not become a private-history authorization.
    expect(policy.canObservePublished(request({ mode: 'observer' }), { ...base, resource: 'trade_history' as PublishedAccountAccessEvidence['resource'] })).toBe(false)
  })
})
