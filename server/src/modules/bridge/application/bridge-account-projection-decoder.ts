import type { BridgeProjectionInput } from '../../trading/index.js'
import { BridgeGatewayError, type BridgeGatewayRoute } from '../domain/bridge-gateway.js'
import type { BridgeStreamEventEnvelope } from './bridge-stream-ingestor.js'

export function decodeAccountProjection(route: BridgeGatewayRoute, event: BridgeStreamEventEnvelope): BridgeProjectionInput {
  const payload = event.payload, data = payload.upserts[0]
  if (!payload.full_snapshot || payload.base_revision !== 0 || payload.deletes.length || payload.upserts.length !== 1 || !data) invalid()
  const fields = ['balance', 'equity', 'margin', 'free_margin', 'floating_profit', 'currency', 'leverage', 'trade_permission']
  if (Object.keys(data).some(key => !fields.includes(key) && key !== 'clock_sample') || fields.some(key => !(key in data))) invalid()
  if (typeof data.currency !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/.test(data.currency)
    || typeof data.trade_permission !== 'boolean'
    || (data.leverage !== null && (!Number.isSafeInteger(data.leverage) || Number(data.leverage) < 1 || Number(data.leverage) > 100000))) invalid()
  if (!Number.isSafeInteger(payload.observed_at_utc_msc) || payload.observed_at_utc_msc < 1
    || !Number.isFinite(new Date(payload.observed_at_utc_msc).getTime())) invalid()
  const observedAt = new Date(payload.observed_at_utc_msc).toISOString()
  return { resource: 'account.metrics', resourceId: 'current', revision: payload.revision, data: {
    id: route.accountId, platform: route.platform, login: route.login, server: route.brokerServer,
    terminalProfileId: route.terminalProfileId, terminalInstanceId: route.terminalInstanceId,
    currency: data.currency, bridgeState: 'online', tradePermission: data.trade_permission,
    lastSeenAt: observedAt, balance: money(data.balance), equity: money(data.equity), margin: money(data.margin),
    freeMargin: money(data.free_margin), floatingProfit: money(data.floating_profit), leverage: data.leverage as number | null,
    // Metrics do not establish a trusted terminal clock. The clock writer retains independently proved evidence.
    timezoneOffsetMinutes: null, clockStatus: 'unavailable', observedAt, revision: payload.revision,
  } }
}
function money(value: unknown): string {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,8})?$/.test(value)) invalid()
  return value
}
function invalid(): never { throw new BridgeGatewayError('bridge_account_snapshot_invalid', 400) }
