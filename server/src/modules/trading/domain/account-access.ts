export interface OwnershipInterval {
  id: string
  accountId: string
  userId: number
  role: 'owner' | 'observer_source'
  startedAtUtc: string
  endedAtUtc: string | null
  originKind: 'legacy' | 'runtime'
  originRef: string
}

export interface AccountAccessRequest {
  userId: number
  active: boolean
  mode: 'full' | 'observer' | 'blocked'
  accountId: string
  nowUtc: string
}

// These are trusted server-side facts, never request-body claims or cached UI flags.
export interface CurrentAccountAccessEvidence {
  accountId: string
  accountDeleted: boolean
  ownershipRevision: string
  expectedOwnershipRevision: string
  grant: {
    userId: number
    accountId: string
    role: 'owner' | 'observer_source'
    intervalId: string | null
    grantedAtUtc: string
    revokedAtUtc: string | null
  } | null
  interval: OwnershipInterval | null
}

export interface ExecutionAccountAccessEvidence {
  current: CurrentAccountAccessEvidence
  connectionPaused: boolean
  tradingEnabled: boolean
  membershipAllowsTrading: boolean
  globalHalted: boolean
  expectedRoute: { profileId: string; instanceId: string; epoch: string }
  route: {
    userId: number
    accountId: string
    profileId: string
    instanceId: string
    epoch: string
    leaseExpiresAtUtc: string
  } | null
}

export interface OwnHistoryAccessEvidence {
  recordId: string
  accountId: string
  userId: number
  // A closed time range covers the entire authorized record, not just its close time.
  firstOccurredAtUtc: string
  lastOccurredAtUtc: string
  attribution:
    | { kind: 'unresolved' }
    | { kind: 'system'; referenceId: string; accountId: string; userId: number }
    | { kind: 'ownership_interval'; interval: OwnershipInterval }
}

export type PublishedAccountResource = 'account.metrics' | 'market.quote' | 'market.candle' | 'positions' | 'pending_orders'

export interface PublishedAccountAccessEvidence {
  accountId: string
  channelId: string
  expectedChannelId: string
  sourceId: string
  expectedSourceId: string
  sourceRevision: string
  expectedSourceRevision: string
  sourceActive: boolean
  sourceReady: boolean
  channelActive: boolean
  published: boolean
  resource: PublishedAccountResource
  audience: 'all' | 'plus' | 'pro' | 'assigned'
  effectivePlan: string
  authorizationExpiresAtUtc: string
  grant: { userId: number; channelId: string; grantedAtUtc: string; revokedAtUtc: string | null } | null
}

// Access checks only. canExecute never substitutes for execution/risk preflight.
// P2 defines this contract; HTTP/repository/collector wiring is a separate P3/P4 gate.
export interface AccountAccessPolicy {
  canReadCurrentAccount(request: AccountAccessRequest, evidence: CurrentAccountAccessEvidence): boolean
  canReadOwnHistory(request: AccountAccessRequest, evidence: OwnHistoryAccessEvidence): boolean
  canExecute(request: AccountAccessRequest, evidence: ExecutionAccountAccessEvidence): boolean
  canObservePublished(request: AccountAccessRequest, evidence: PublishedAccountAccessEvidence): boolean
}

export function isPositiveDatabaseId(value: string): boolean {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
}

export function isValidUserId(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 2147483647
}

export function utcMilliseconds(value: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : NaN
}

export function validOwnershipInterval(interval: OwnershipInterval): boolean {
  const start = utcMilliseconds(interval.startedAtUtc)
  const end = interval.endedAtUtc === null ? Infinity : utcMilliseconds(interval.endedAtUtc)
  return typeof interval.id === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(interval.id)
    && isPositiveDatabaseId(interval.accountId) && isValidUserId(interval.userId)
    && (interval.role === 'owner' || interval.role === 'observer_source')
    && (interval.originKind === 'legacy' || interval.originKind === 'runtime')
    && typeof interval.originRef === 'string' && /^[\x21-\x7e]{1,191}$/.test(interval.originRef)
    && Number.isFinite(start) && end >= start
}

// Offline/write-precondition validation, not a lock or a concurrency guarantee.
// Callers must retain the full authoritative account history, including closed rows.
export function validateOwnershipTimeline(intervals: readonly OwnershipInterval[]):
  { ok: true } | { ok: false; reason: 'invalid_interval' | 'duplicate_interval' | 'duplicate_origin' | 'owner_overlap' } {
  const ids = new Set<string>()
  const origins = new Set<string>()
  const owners = new Map<string, OwnershipInterval[]>()
  for (const interval of intervals) {
    if (!validOwnershipInterval(interval)) return { ok: false, reason: 'invalid_interval' }
    const id = interval.id.toLowerCase()
    if (ids.has(id)) return { ok: false, reason: 'duplicate_interval' }
    ids.add(id)
    const origin = `${interval.originKind}:${interval.originRef}`
    if (origins.has(origin)) return { ok: false, reason: 'duplicate_origin' }
    origins.add(origin)
    if (interval.role !== 'owner' || interval.startedAtUtc === interval.endedAtUtc) continue
    const accountIntervals = owners.get(interval.accountId) ?? []
    accountIntervals.push(interval)
    owners.set(interval.accountId, accountIntervals)
  }
  for (const accountIntervals of owners.values()) {
    accountIntervals.sort((a, b) => utcMilliseconds(a.startedAtUtc) - utcMilliseconds(b.startedAtUtc))
    let end = -Infinity
    for (const interval of accountIntervals) {
      if (utcMilliseconds(interval.startedAtUtc) < end) return { ok: false, reason: 'owner_overlap' }
      end = interval.endedAtUtc === null ? Infinity : utcMilliseconds(interval.endedAtUtc)
    }
  }
  return { ok: true }
}
