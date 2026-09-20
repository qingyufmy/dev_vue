import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import type { OpenPositionHistoryReader } from '../modules/trade-history/index.js'
import { readReferencePositionLifecycles, type ReferencePositionEvidenceReader,
  type ReferencePositionHistoryEvidence } from '../modules/inference/index.js'
import { sha256Canonical } from '../shared/canonical-json.js'

/** Full server lease is required; never reconstruct session or timezone from the minimal inventory route. */
export function createReferencePositionEvidenceReader(routes: Pick<BridgeGatewayLeaseStore, 'current'>,
  history: OpenPositionHistoryReader): ReferencePositionEvidenceReader {
  return { async read(input) {
    const inventory = structuredClone(input)
    if (inventory.route.platform !== 'mt5') return { status: 'unresolved', reason: 'unsupported_platform' }
    const current = await routes.current(inventory.route.accountId)
    if (!current) return { status: 'unresolved', reason: 'route_unavailable' }
    const route = structuredClone(current)
    const keys = ['userId', 'accountId', 'platform', 'brokerServer', 'login', 'terminalProfileId',
      'terminalInstanceId', 'connectionId', 'connectionEpoch'] as const
    if (keys.some(key => route[key] !== inventory.route[key])
      || typeof route.ownershipRevision !== 'string' || !/^[1-9]\d{0,19}$/.test(route.ownershipRevision)
      || route.ownershipRevision !== inventory.authorization.ownershipRevision
      || route.userId !== inventory.authorization.operatorUserId
      || typeof route.sessionId !== 'string' || !route.sessionId
      || !Number.isInteger(route.timezoneOffsetMinutes) || Math.abs(route.timezoneOffsetMinutes!) > 840) {
      return { status: 'unresolved', reason: 'route_unavailable' }
    }
    const items: Array<{ ticket: string; history: ReferencePositionHistoryEvidence }> = []
    // Reuse inventory validation, quantity matching and complete unique lifecycle ticket validation.
    let index = 0
    await readReferencePositionLifecycles(inventory, { async read(scope) {
      const evidence = structuredClone(await history.read({ ...scope, route: structuredClone(route) }))
      items.push({ ticket: inventory.positions.items[index++]!.ticket, history: evidence })
      return evidence.status === 'source_matched' ? evidence.lifecycle : { status: 'unresolved', reason: 'snapshot_mismatch' }
    } })
    const latest = await routes.current(route.accountId)
    if (!latest || sha256Canonical(latest) !== sha256Canonical(route)) {
      return { status: 'unresolved', reason: 'route_unavailable' }
    }
    return { status: 'read', items }
  } }
}
