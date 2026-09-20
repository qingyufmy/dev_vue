import { expect, it, vi } from 'vitest'
import type { StrategyObserverInventory } from '../src/modules/trading/index.js'
import { createReferencePositionEvidenceReader } from '../src/bootstrap/strategy-reference-position-evidence.js'
function fixture() {
  const route = { userId: 8, accountId: '9', platform: 'mt5' as const, brokerServer: 'Broker', login: '001',
    terminalProfileId: 'profile', terminalInstanceId: 'terminal', connectionId: 'connection', connectionEpoch: 4,
    ownershipRevision: '5', sessionId: 'session', timezoneOffsetMinutes: 180 }
  const inventory = { route, authorization: { operatorUserId: 8, ownershipRevision: '5' }, positions: {
    revision: 2, observedAt: '2026-09-10T00:00:00.000Z', items: [{ accountId: '9', ticket: '11', positionIdentifier: '10',
      revision: 2, symbol: 'XAUUSD', side: 'buy', volume: '1' }] } } as unknown as StrategyObserverInventory
  const evidence = { status: 'source_matched', taskId: 'task', receiptId: 'receipt', completionHash: 'hash', deals: [],
    lifecycle: { status: 'matches_snapshot', positionIdentifier: '10', side: 'buy', volume: '1', contributingOrderTickets: ['12'], dealTickets: ['13'] } }
  const routes = { current: vi.fn().mockImplementation(async () => structuredClone(route)) }
  const history = { read: vi.fn().mockResolvedValue(evidence) }
  return { route, inventory, evidence, routes, history, reader: createReferencePositionEvidenceReader(routes, history) }
}
it('passes full lease and inventory observation time, retaining task and lifecycle evidence', async () => {
  const f = fixture()
  expect(await f.reader.read(f.inventory)).toEqual({ status: 'read', items: [{ ticket: '11', history: f.evidence }] })
  expect(f.history.read).toHaveBeenCalledWith({ accountId: '9', route: f.route, positionIdentifier: '10', symbol: 'XAUUSD',
    side: 'buy', volume: '1', observedAtUtcMsc: Date.parse(f.inventory.positions.observedAt) })
  expect(f.routes.current).toHaveBeenCalledTimes(2)
})
it.each(['sessionId', 'ownershipRevision', 'timezoneOffsetMinutes', 'login', 'connectionEpoch'])('rejects unavailable or changed lease field %s before history reads', async field => {
  const f = fixture(), changed = { ...f.route, [field]: field === 'timezoneOffsetMinutes' ? null : 'other' }
  if (field === 'sessionId') changed.sessionId = ''
  f.routes.current.mockResolvedValue(changed)
  expect(await f.reader.read(f.inventory)).toEqual({ status: 'unresolved', reason: 'route_unavailable' })
  expect(f.history.read).not.toHaveBeenCalled()
})
it('discards results after a session switch during the read', async () => {
  const f = fixture(); f.routes.current.mockResolvedValueOnce(f.route).mockResolvedValueOnce({ ...f.route, sessionId: 'new-session' })
  expect(await f.reader.read(f.inventory)).toEqual({ status: 'unresolved', reason: 'route_unavailable' })
})
it('retains missing coverage as unresolved, without manufacturing empty success', async () => {
  const f = fixture(); f.history.read.mockResolvedValue({ status: 'unresolved', reason: 'coverage_unavailable' })
  expect(await f.reader.read(f.inventory)).toEqual({ status: 'read', items: [{ ticket: '11', history: { status: 'unresolved', reason: 'coverage_unavailable' } }] })
})
it('rejects mismatched lifecycle instead of associating it with a position', async () => {
  const f = fixture(); f.evidence.lifecycle.positionIdentifier = '99'
  await expect(f.reader.read(f.inventory)).rejects.toThrow('strategy_reference_position_lifecycle_invalid')
})
it('does not represent MT4 as an empty proved portfolio', async () => {
  const f = fixture(); f.inventory.route.platform = 'mt4'
  expect(await f.reader.read(f.inventory)).toEqual({ status: 'unresolved', reason: 'unsupported_platform' })
  expect(f.history.read).not.toHaveBeenCalled()
})
