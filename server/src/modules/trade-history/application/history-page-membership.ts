import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope, BridgeHistoryResource } from '../../bridge/index.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'
import type { HistoryResourcePageChain, HistoryPageMember } from './trade-history-collector-ports.js'

export function historyPageMember(cursor: string | null, response: BridgeQueryResponseEnvelope): HistoryPageMember {
  return { requestedCursor: cursor, responseHash: canonicalEvidence(response as unknown as Record<string, unknown>).hash,
    requestId: response.payload.request_id, queryMessageId: response.correlation_id, responseMessageId: response.message_id,
    itemCount: response.payload.items.length,
    factHashes: [...new Set(response.payload.items.map(item => canonicalEvidence(item).hash))].sort() }
}
export function assertHistoryPageMembership(route: BridgeGatewayRoute, chain: HistoryResourcePageChain) {
  if (!Object.hasOwn(chain, 'pageMembership')) return
  const fail = (): never => { throw Error('history_page_membership_invalid') }
  const proof = chain.pageMembership
  if (!proof || proof.version !== 1 || !Array.isArray(proof.pages) || proof.pages.length !== chain.pageCount
    || proof.pages.length < 1 || proof.pages.length > 2000) return fail()
  const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/.test(v)
  let digest = historyPageChainSeed(route, chain, chain.resource)
  let items = 0, members = 0
  for (const [index, page] of proof.pages.entries()) {
    if (!page || !hash(page.responseHash) || !text(page.requestId) || !text(page.responseMessageId)
      || !text(page.queryMessageId)
      || (index === 0 ? page.requestedCursor !== null : typeof page.requestedCursor !== 'string' || page.requestedCursor.length < 1 || page.requestedCursor.length > 2048)
      || !Number.isSafeInteger(page.itemCount) || page.itemCount < 0 || page.itemCount > 500 || !Array.isArray(page.factHashes)
      || page.factHashes.length > page.itemCount || (page.itemCount > 0 && page.factHashes.length === 0)
      || !page.factHashes.every(hash) || page.factHashes.some((v,i) => i > 0 && v <= page.factHashes[i-1]!)) return fail()
    items += page.itemCount; members += page.factHashes.length
    digest = canonicalEvidence({ previousHash: digest, pageIndex: index, requestedCursor: page.requestedCursor, responseHash: page.responseHash }).hash
  }
  if (members > 10000 || items !== chain.itemCount || digest !== chain.pageChainHash) return fail()
}

/** Credential proof is re-authorized separately and is not part of persisted task route identity. */
export function historyPageChainSeed(route: BridgeGatewayRoute, window: { rangeStartUtcMsc: number; rangeEndUtcMsc: number }, resource: BridgeHistoryResource) {
  const { installationId: _installation, credentialGeneration: _generation, ...identity } = route
  return canonicalEvidence({version:1,route:identity,window:{rangeStartUtcMsc:window.rangeStartUtcMsc,rangeEndUtcMsc:window.rangeEndUtcMsc},resource}).hash
}
