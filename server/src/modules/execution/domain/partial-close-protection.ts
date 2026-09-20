/** Eligibility only. A successful result still requires a new current risk review. */
export interface ProtectionTarget {
  readonly userId: string
  readonly accountId: string
  readonly terminalInstanceId: string
  readonly brokerServer: string
  readonly login: string
  readonly positionIdentifier: string
  readonly ticket: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
}

export interface PartialCloseProtectionPlan {
  readonly workflowId: string
  readonly parentIntentId: string
  readonly parentCommandId: string
  readonly target: ProtectionTarget
  readonly initialVolume: string
  readonly closeVolume: string
  readonly initialRevision: number
  readonly expiresAt: number
  readonly protection: { readonly stopLoss?: string; readonly takeProfit?: string }
}

/** The history adapter must establish exact command/deal attribution before supplying this proof. */
export interface PartialCloseHistoryProof {
  readonly parentIntentId: string
  readonly parentCommandId: string
  readonly target: ProtectionTarget
  readonly closedVolume: string
  readonly completedAt: number
}

export interface ProtectionProjection {
  readonly route: Pick<ProtectionTarget, 'userId' | 'accountId' | 'terminalInstanceId' | 'brokerServer' | 'login'>
  readonly complete: boolean
  readonly revision: number
  readonly observedAt: number
  readonly positions: readonly { readonly target: ProtectionTarget; readonly volume: string }[]
}

export type ProtectionEligibility =
  | { readonly state: 'wait_close' | 'reconcile_close' | 'wait_history' | 'wait_projection' | 'expired' }
  | { readonly state: 'stopped'; readonly reason: string }
  | { readonly state: 'risk_review_required'; readonly workflowId: string; readonly target: ProtectionTarget;
      readonly remainingVolume: string; readonly projectionRevision: number; readonly projectionObservedAt: number;
      readonly protection: PartialCloseProtectionPlan['protection'] }

const routeKeys = ['userId', 'accountId', 'terminalInstanceId', 'brokerServer', 'login'] as const
const targetKeys = [...routeKeys, 'positionIdentifier', 'ticket', 'symbol', 'side'] as const
const scale = 10n ** 18n
function units(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const result = BigInt(whole!) * scale + BigInt(fraction.padEnd(18, '0'))
  return result > 0n ? result : null
}
export function partialCloseVolumeEquals(left: string, right: string): boolean {
  const first = units(left), second = units(right)
  return first !== null && first === second
}
export function partialCloseRemainingVolume(initial: string, closed: string): string | null {
  const first = units(initial), second = units(closed)
  return first !== null && second !== null && first > second ? decimal(first - second) : null
}
function decimal(value: bigint): string {
  const fraction = (value % scale).toString().padStart(18, '0').replace(/0+$/, '')
  return `${value / scale}${fraction ? `.${fraction}` : ''}`
}
const time = (value: number) => Number.isSafeInteger(value) && value >= 0
const revision = (value: number) => Number.isSafeInteger(value) && value >= 0
const stopped = (reason: string): ProtectionEligibility => ({ state: 'stopped', reason })

export function evaluatePartialCloseProtection(input: {
  readonly plan: PartialCloseProtectionPlan
  readonly parentState: 'pending' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled'
  readonly history: PartialCloseHistoryProof | null
  readonly projection: ProtectionProjection | null
  readonly now: number
  readonly maxProjectionAgeMs: number
}): ProtectionEligibility {
  const { plan, history, projection, now } = input
  const initial = units(plan.initialVolume), close = units(plan.closeVolume)
  if (!initial || !close || close >= initial || !revision(plan.initialRevision) || !time(plan.expiresAt)
    || !time(now) || !time(input.maxProjectionAgeMs) || input.maxProjectionAgeMs === 0
    || ![plan.workflowId, plan.parentIntentId, plan.parentCommandId, ...targetKeys.map(key => plan.target[key])]
      .every(value => typeof value === 'string' && value.length > 0)
    || !['buy', 'sell'].includes(plan.target.side)
    || Object.keys(plan.protection).some(key => key !== 'stopLoss' && key !== 'takeProfit')
    || (plan.protection.stopLoss === undefined && plan.protection.takeProfit === undefined)
    || [plan.protection.stopLoss, plan.protection.takeProfit].some(value => value !== undefined && units(value) === null)) {
    return stopped('invalid_plan')
  }
  // Even after expiry, an unknown close must remain visible to the reconciliation owner.
  if (input.parentState === 'uncertain') return { state: 'reconcile_close' }
  if (input.parentState === 'failed' || input.parentState === 'cancelled') return stopped('close_not_completed')
  if (now >= plan.expiresAt) return { state: 'expired' }
  if (input.parentState === 'pending') return { state: 'wait_close' }
  if (!history) return { state: 'wait_history' }
  if (history.parentIntentId !== plan.parentIntentId || history.parentCommandId !== plan.parentCommandId
    || targetKeys.some(key => history.target[key] !== plan.target[key])
    || units(history.closedVolume) !== close || !time(history.completedAt) || history.completedAt > now) {
    return stopped('close_proof_mismatch')
  }
  if (!projection) return { state: 'wait_projection' }
  if (routeKeys.some(key => projection.route[key] !== plan.target[key])) return stopped('projection_route_mismatch')
  if (!projection.complete || !revision(projection.revision) || projection.revision <= plan.initialRevision
    || !time(projection.observedAt) || projection.observedAt < history.completedAt
    || projection.observedAt > now || now - projection.observedAt > input.maxProjectionAgeMs) {
    return { state: 'wait_projection' }
  }
  // Both stable identity and ticket must still identify one and the same position.
  const candidates = projection.positions.filter(position => position.target.ticket === plan.target.ticket
    || position.target.positionIdentifier === plan.target.positionIdentifier)
  if (candidates.length === 0) return stopped('position_absent')
  const position = candidates[0]!
  if (candidates.length !== 1 || targetKeys.some(key => position.target[key] !== plan.target[key])) {
    return stopped('position_identity_mismatch')
  }
  const remaining = initial - close
  if (units(position.volume) !== remaining) return stopped('remaining_volume_mismatch')
  return { state: 'risk_review_required', workflowId: plan.workflowId, target: { ...plan.target },
    remainingVolume: decimal(remaining), projectionRevision: projection.revision,
    projectionObservedAt: projection.observedAt, protection: { ...plan.protection } }
}
