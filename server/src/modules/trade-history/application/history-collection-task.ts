import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { TradeHistoryCollectionWindow } from './trade-history-collector-ports.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

export interface HistoryCollectionRequest extends TradeHistoryCollectionWindow {
  taskId: string
  accountId: string
}
export interface HistoryCollectionClaim extends HistoryCollectionRequest {
  leaseToken: string
  routeHash: string
}

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const uint64 = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v)
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && Number.isFinite(new Date(v).getTime())

/** Route identity is frozen per claim, including the time-zone used by projections. */
export function historyTaskRoute(route: BridgeGatewayRoute) {
  const r = structuredClone(route)
  if (!uint64(r.accountId) || !uint64(r.ownershipRevision) || !Number.isSafeInteger(r.userId) || r.userId < 1
    || !['mt4', 'mt5'].includes(r.platform) || !Number.isSafeInteger(r.connectionEpoch) || r.connectionEpoch < 1
    || ![r.terminalInstanceId, r.terminalProfileId, r.brokerServer, r.connectionId, r.sessionId].every(v => text(v)) || !text(r.login, 64)
    || r.timezoneOffsetMinutes === null || !Number.isInteger(r.timezoneOffsetMinutes) || Math.abs(r.timezoneOffsetMinutes) > 840) throw Error('history_task_route_invalid')
  const value = { accountId: r.accountId, userId: r.userId, platform: r.platform, terminalInstanceId: r.terminalInstanceId,
    terminalProfileId: r.terminalProfileId, brokerServer: r.brokerServer, login: r.login, connectionId: r.connectionId,
    sessionId: r.sessionId, connectionEpoch: r.connectionEpoch, ownershipRevision: r.ownershipRevision, timezoneOffsetMinutes: r.timezoneOffsetMinutes }
  return { value, ...canonicalEvidence(value) }
}

export function freezeHistoryCollectionClaim(claim: HistoryCollectionClaim) {
  const value = structuredClone(claim)
  if (!uuid(value.taskId) || !uuid(value.leaseToken) || !uint64(value.accountId) || !/^[0-9a-f]{64}$/.test(value.routeHash)
    || !time(value.rangeStartUtcMsc) || !time(value.rangeEndUtcMsc) || value.rangeStartUtcMsc >= value.rangeEndUtcMsc) throw Error('history_task_claim_invalid')
  return value
}

export function freezeHistoryCollectionRequest(request: HistoryCollectionRequest) {
  const value = structuredClone(request)
  if (!uuid(value.taskId) || !uint64(value.accountId) || !time(value.rangeStartUtcMsc) || !time(value.rangeEndUtcMsc)
    || value.rangeStartUtcMsc >= value.rangeEndUtcMsc) throw Error('history_task_request_invalid')
  return value
}
