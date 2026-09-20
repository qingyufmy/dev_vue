import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { HistoryResourcePageChain } from '../src/modules/trade-history/application/trade-history-collector-ports.js'
import { historyTaskRoute } from '../src/modules/trade-history/application/history-collection-task.js'
import { historyTaskCompletion, restoreHistoryTaskCompletion } from '../src/modules/trade-history/application/history-task-completion.js'
import { prepareHistoryTaskCompletion, loadHistoryTaskCompletion } from '../src/modules/trade-history/infrastructure/mysql-history-task-completion.js'
import { canonicalEvidence } from '../src/modules/trade-history/domain/terminal-history-projection.js'

const route: BridgeGatewayRoute = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', terminalProfileId: 'profile',
  brokerServer: 'Broker', login: '001', connectionEpoch: 3, connectionId: 'connection', sessionId: 'session', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
const claim = { taskId: '00000000-0000-4000-8000-000000000001', accountId: '5', leaseToken: '00000000-0000-4000-8000-000000000002',
  rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, routeHash: historyTaskRoute(route).hash }
const chains: HistoryResourcePageChain[] = ['history.orders', 'history.deals'].map(resource => ({ resource: resource as HistoryResourcePageChain['resource'],
  rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, source: 'terminal', sourceRevision: 'r1', pageCount: 1, itemCount: 3, pageChainHash: 'a'.repeat(64) }))

it('freezes canonical completion independently of lease takeover and input resource order', () => {
  const prepared = historyTaskCompletion(claim, route, chains)
  const takeover = { ...claim, leaseToken: '00000000-0000-4000-8000-000000000003' }
  expect(historyTaskCompletion(takeover, route, [...chains].reverse()).hash).toBe(prepared.hash)
  expect(restoreHistoryTaskCompletion(takeover, route, prepared.json, prepared.hash)).toEqual(prepared)
  expect(prepared.json).not.toContain('leaseToken')
})
it.each(['extra', 'task', 'account', 'route', 'window', 'receipt', 'resource'])('rejects corrupted completion even with recomputed outer hash: %s', kind => {
  const raw: Record<string, unknown> = structuredClone(historyTaskCompletion(claim, route, chains).value)
  if (kind === 'extra') raw.extra = true
  if (kind === 'task') raw.taskId = '00000000-0000-4000-8000-000000000004'
  if (kind === 'account') raw.accountId = '6'
  if (kind === 'route') raw.routeHash = 'b'.repeat(64)
  if (kind === 'window') raw.rangeEndUtcMsc = 3000
  if (kind === 'receipt') raw.receiptHash = 'b'.repeat(64)
  if (kind === 'resource') raw.pageChains = [chains[0]]
  const altered = canonicalEvidence(raw)
  expect(() => restoreHistoryTaskCompletion(claim, route, altered.json, altered.hash)).toThrow('history_task_completion_corrupt')
})
it('rejects a resource window that differs from the claimed window', () => {
  expect(() => historyTaskCompletion({ ...claim, rangeStartUtcMsc: 500 }, route, chains)).toThrow('history_task_window_mismatch')
})

function fixture() {
  const state = { status: 'running', completion_json: null as string | null, completion_sha256: null as string | null, affectedRows: 1 }
  const execute = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT @@session')) return [[{ session_timezone: '+00:00', status: state.status, lease_token: claim.leaseToken, lease_live: 1,
      route_sha256: claim.routeHash, route_json: historyTaskRoute(route).json, start_msc: '1000', end_msc: '2000' }]]
    if (sql.startsWith('SELECT completion_json')) return [[{ completion_json: state.completion_json, completion_sha256: state.completion_sha256 }]]
    if (sql.startsWith('UPDATE')) {
      state.completion_json = String(params[0]); state.completion_sha256 = String(params[1]); state.status = 'completing'
      return [{ affectedRows: state.affectedRows }]
    }
    throw Error('unexpected_sql')
  })
  return { state, execute, connection: { execute } as unknown as PoolConnection }
}
it('persists completion before allowing restore, then replays without an update', async () => {
  const f = fixture()
  await expect(loadHistoryTaskCompletion(f.connection, claim, route)).rejects.toThrow('history_task_lease_lost')
  const result = await prepareHistoryTaskCompletion(f.connection, claim, route, chains)
  expect(await loadHistoryTaskCompletion(f.connection, claim, route)).toEqual(result)
  expect(await prepareHistoryTaskCompletion(f.connection, claim, route, chains)).toEqual(result)
  expect(f.execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(1)
})
it('never overwrites an existing different completion', async () => {
  const f = fixture()
  await prepareHistoryTaskCompletion(f.connection, claim, route, chains)
  const changed = chains.map(c => ({ ...c, sourceRevision: 'different' }))
  await expect(prepareHistoryTaskCompletion(f.connection, claim, route, changed)).rejects.toThrow('history_task_completion_conflict')
  expect(f.execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(1)
})
it('refuses a lost lease at the final conditional update', async () => {
  const f = fixture(); f.state.affectedRows = 0
  await expect(prepareHistoryTaskCompletion(f.connection, claim, route, chains)).rejects.toThrow('history_task_lease_lost')
})


function coveredChains() {
  return chains.map(chain => ({ ...chain, historyCoverage: { version: 1 as const, status: 'complete' as const,
    range_start_utc_msc: 1000, range_end_utc_msc: 2000, source_revision: 'r1', collected_at_utc_msc: 2100 } }))
}
it('persists coverage through preparation and lease takeover without changing legacy receipt identity', async () => {
  const input = coveredChains(), f = fixture()
  const prepared = await prepareHistoryTaskCompletion(f.connection, claim, route, input)
  expect(JSON.parse(f.state.completion_json!).pageChains[0].historyCoverage).toEqual(input[0]!.historyCoverage)
  input[0]!.historyCoverage.collected_at_utc_msc = 9999
  expect((await loadHistoryTaskCompletion(f.connection, claim, route)).hash).toBe(prepared.hash)
  const takeover = { ...claim, leaseToken: '00000000-0000-4000-8000-000000000003' }
  expect(restoreHistoryTaskCompletion(takeover, route, prepared.json, prepared.hash)).toEqual(prepared)
  expect(prepared.value.receiptHash).toBe(historyTaskCompletion(claim, route, chains).value.receiptHash)
  expect(prepared.hash).not.toBe(historyTaskCompletion(claim, route, chains).hash)
  await expect(prepareHistoryTaskCompletion(f.connection, claim, route, input)).rejects.toThrow('history_task_completion_conflict')
  expect(f.execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(1)
})
it.each(['window','revision','time','extra'])('rejects malformed durable coverage even after outer hash is recomputed: %s', kind => {
  const value = historyTaskCompletion(claim, route, coveredChains()).value
  const coverage = value.pageChains[0]!.historyCoverage!
  if (kind === 'window') coverage.range_start_utc_msc = 999
  if (kind === 'revision') coverage.source_revision = 'other'
  if (kind === 'time') coverage.collected_at_utc_msc = 1999
  if (kind === 'extra') Object.assign(coverage, { extra: true })
  const altered = canonicalEvidence(value)
  expect(() => restoreHistoryTaskCompletion(claim, route, altered.json, altered.hash)).toThrow('history_task_completion_corrupt')
})
it('preserves the original v1 canonical payload when coverage is absent', () => {
  const result = historyTaskCompletion(claim, route, chains)
  const legacy = { version: 1, taskId: claim.taskId, accountId: claim.accountId, routeHash: claim.routeHash,
    rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000, receiptHash: result.value.receiptHash,
    pageChains: structuredClone(chains).sort((a,b) => a.resource.localeCompare(b.resource)) }
  expect(result.json).toBe(canonicalEvidence(legacy).json)
  expect(result.value.pageChains.every(chain => !Object.hasOwn(chain,'historyCoverage'))).toBe(true)
})
