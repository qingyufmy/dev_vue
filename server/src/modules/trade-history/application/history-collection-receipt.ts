import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { HistoryResourcePageChain } from './trade-history-collector-ports.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

export function historyCollectionReceipt(route: BridgeGatewayRoute, freshThroughUtcMsc: number, chains: readonly HistoryResourcePageChain[]) {
  const input = structuredClone({ route, chains, freshThroughUtcMsc })
  const invalid = (): never => { throw Error('trade_history_collection_receipt_invalid') }
  const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n
  const text = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v)
  const r = input.route
  if (!id(r.accountId) || !Number.isSafeInteger(r.userId) || r.userId < 1 || !['mt4', 'mt5'].includes(r.platform)
    || ![r.terminalInstanceId, r.terminalProfileId, r.brokerServer, r.connectionId].every(v => text(v)) || !text(r.login, 64)
    || !Number.isSafeInteger(r.connectionEpoch) || r.connectionEpoch < 1
    || (r.ownershipRevision !== undefined && !id(r.ownershipRevision)) || !Array.isArray(input.chains)) return invalid()
  const required = r.platform === 'mt5' ? ['history.orders', 'history.deals'] : ['history.trades']
  if (input.chains.length !== required.length || new Set(input.chains.map(c => c.resource)).size !== required.length) return invalid()
  const start = input.chains[0]?.rangeStartUtcMsc
  if (!Number.isSafeInteger(start) || start! < 1 || !Number.isSafeInteger(freshThroughUtcMsc) || freshThroughUtcMsc <= start!) return invalid()
  const resources = input.chains.map(c => {
    if (!required.includes(c.resource) || c.rangeStartUtcMsc !== start || c.rangeEndUtcMsc !== freshThroughUtcMsc
      || !text(c.sourceRevision, 191) || !['terminal', 'local_projection'].includes(c.source)
      || !Number.isSafeInteger(c.pageCount) || c.pageCount < 1 || c.pageCount > 2000
      || !Number.isSafeInteger(c.itemCount) || c.itemCount < 0 || c.itemCount > c.pageCount * 500
      || typeof c.pageChainHash !== 'string' || !/^[0-9a-f]{64}$/.test(c.pageChainHash)) return invalid()
    return { resource: c.resource, sourceRevision: c.sourceRevision, source: c.source,
      pageCount: c.pageCount, itemCount: c.itemCount, pageChainHash: c.pageChainHash }
  }).sort((a, b) => a.resource.localeCompare(b.resource))
  const evidence = { version: 1, accountId: r.accountId, userId: r.userId, platform: r.platform,
    terminalInstanceId: r.terminalInstanceId, terminalProfileId: r.terminalProfileId, brokerServer: r.brokerServer,
    login: r.login, connectionId: r.connectionId, connectionEpoch: String(r.connectionEpoch), ownershipRevision: r.ownershipRevision ?? null,
    rangeStartUtcMsc: start!, rangeEndUtcMsc: freshThroughUtcMsc, resources }
  return { evidence, ...canonicalEvidence(evidence) }
}
