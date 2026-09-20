import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../../bridge/index.js'
import { canonicalEvidence, type TerminalDealFact } from '../domain/terminal-history-projection.js'

const invalid = (): never => { throw new Error('trade_history_deal_provenance_invalid') }
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || !/^[\x20-\x7e]+$/.test(value)) return invalid()
  return value
}
function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid()
}

/** Build only after transaction route authorization. Received time is deliberately outside
 * the evidence hash so an identical response replay does not become a different fact. */
export function historyDealProvenance(input: {
  route: BridgeGatewayRoute; response: BridgeQueryResponseEnvelope; dealId: string; fact: TerminalDealFact; receivedAt: Date
}) {
  const { route, response, fact } = structuredClone(input)
  const received = input.receivedAt.getTime()
  if (!Number.isSafeInteger(received) || received <= 0 || response.v !== 4 || response.type !== 'query.response'
    || response.payload.resource !== (route.platform === 'mt5' ? 'history.deals' : 'history.trades') || !['mt4', 'mt5'].includes(route.platform)) return invalid()
  if (response.route.terminal_instance_id !== route.terminalInstanceId || response.route.connection_epoch !== route.connectionEpoch
    || response.route.account_ref.broker_server !== route.brokerServer || response.route.account_ref.login !== route.login) return invalid()
  const observed = integer(response.payload.observed_at_utc_msc)
  const sent = integer(response.sent_at_utc_msc)
  if (observed > sent || sent > received || !['terminal', 'local_projection'].includes(response.payload.source)) return invalid()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.dealId)
    || !/^[1-9]\d{0,19}$/.test(route.accountId) || !/^[1-9]\d{0,19}$/.test(route.ownershipRevision ?? '')
    || !/^[0-9a-f]{64}$/.test(fact.evidenceHash) || fact.kind !== 'deal'
    || BigInt(route.accountId) > 18446744073709551615n || BigInt(route.ownershipRevision!) > 18446744073709551615n) return invalid()
  if (canonicalEvidence(JSON.parse(fact.evidenceJson) as Record<string, unknown>).hash !== fact.evidenceHash) return invalid()
  if (!Array.isArray(response.payload.items) || !response.payload.items.some(item => canonicalEvidence(item).hash === fact.evidenceHash)) return invalid()
  const evidence = {
    version: 1, dealId: input.dealId, accountId: route.accountId, userId: integer(route.userId), platform: route.platform,
    terminalInstanceId: text(route.terminalInstanceId), terminalProfileId: text(route.terminalProfileId),
    brokerServer: text(route.brokerServer), login: text(route.login, 64), connectionId: text(route.connectionId),
    connectionEpoch: String(integer(route.connectionEpoch)), ownershipRevision: route.ownershipRevision!,
    requestId: text(response.payload.request_id), queryMessageId: text(response.correlation_id), responseMessageId: text(response.message_id),
    sourceRevision: text(response.payload.source_revision), sourceKind: response.payload.source,
    factHash: fact.evidenceHash, observedAt: new Date(observed).toISOString(),
  }
  return { ...evidence, provenanceHash: canonicalEvidence(evidence).hash, receivedAt: new Date(received).toISOString() }
}
