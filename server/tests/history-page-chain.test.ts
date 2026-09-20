import { expect, it, vi } from 'vitest'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'
import { HistoryPageChain } from '../src/modules/trade-history/application/history-page-chain.js'
import { TradeHistoryCollector } from '../src/modules/trade-history/application/trade-history-collector.js'

const route = { userId: 7, accountId: '42', platform: 'mt5', timezoneOffsetMinutes: 180, terminalProfileId: 'profile_12345678',
  terminalInstanceId: 'terminal_12345678', brokerServer: 'Broker', login: '001', connectionEpoch: 3,
  connectionId: 'connection_12345678', sessionId: 'session_12345678' } satisfies BridgeGatewayRoute
const window = { rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000 }
function response(next: string | null = null): BridgeQueryResponseEnvelope {
  return { v: 4, message_id: 'response_12345678', type: 'query.response', sent_at_utc_msc: 3000, correlation_id: 'message_12345678',
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: 3 },
    payload: { request_id: 'request_12345678', resource: 'history.deals', observed_at_utc_msc: 2500, source_revision: 'revision_1',
      source: 'local_projection', items: [], has_more: next !== null, next_cursor: next } }
}

it('binds the completed page chain to the frozen route/window and all response content', () => {
  const build = (count: number) => {
    const r = structuredClone(route), w = { ...window }, chain = new HistoryPageChain(r, w, 'history.deals')
    r.login = 'other'; w.rangeStartUtcMsc = 1999
    const first = response('cursor_2'); first.payload.items = Array.from({ length: count }, () => ({ ticket: '1' }))
    chain.append(null, first)
    const last = response(); last.payload.observed_at_utc_msc = 2000 // Per-page observation timestamps may differ.
    chain.append('cursor_2', last)
    const finished = chain.finish()
    first.payload.items = []; finished.sourceRevision = 'changed'
    expect(chain.finish().sourceRevision).toBe('revision_1')
    return chain.finish()
  }
  expect(build(1)).toMatchObject({ ...window, sourceRevision: 'revision_1', pageCount: 2, itemCount: 1 })
  expect(build(1).pageChainHash).toBe(build(1).pageChainHash)
  expect(build(1).pageChainHash).not.toBe(build(2).pageChainHash)
})

it.each(['revision', 'source', 'epoch', 'resource', 'cursor', 'loop'])('rejects broken page chains before completion: %s', kind => {
  const chain = new HistoryPageChain(route, window, 'history.deals')
  chain.append(null, response('cursor_2'))
  const next = response()
  if (kind === 'revision') next.payload.source_revision = 'other'
  if (kind === 'source') next.payload.source = 'terminal'
  if (kind === 'epoch') next.route.connection_epoch++
  if (kind === 'resource') next.payload.resource = 'history.orders'
  if (kind === 'loop') { next.payload.has_more = true; next.payload.next_cursor = 'cursor_2' }
  expect(() => chain.append(kind === 'cursor' ? 'wrong' : 'cursor_2', next)).toThrow()
  expect(() => chain.finish()).toThrow('trade_history_page_chain_incomplete')
})

it('rejects unfinished, over-appended and invalid-window chains', () => {
  expect(() => new HistoryPageChain(route, { ...window, rangeStartUtcMsc: 2000 }, 'history.deals')).toThrow('trade_history_window_invalid')
  const chain = new HistoryPageChain(route, window, 'history.deals')
  expect(() => chain.finish()).toThrow('trade_history_page_chain_incomplete')
  chain.append(null, response())
  expect(() => chain.append(null, response())).toThrow('trade_history_page_sequence_invalid')
})

it('does not persist the changed-source page or mark sync ready', async () => {
  const persistPage = vi.fn(), complete = vi.fn(), fail = vi.fn()
  const collector = new TradeHistoryCollector({ begin: async () => window, persistPage, complete, fail }, { query: async input => {
    const page = response(input.resource === 'history.deals' && input.cursor === null ? 'cursor_2' : null)
    page.payload.resource = input.resource
    if (input.cursor !== null) page.payload.source_revision = 'changed'
    return page
  } }, () => new Date(3000))
  await expect(collector.collect(route)).rejects.toThrow('trade_history_page_source_changed')
  expect(persistPage).toHaveBeenCalledTimes(2)
  expect(complete).not.toHaveBeenCalled()
  expect(fail).toHaveBeenCalledWith(route, 'trade_history_page_source_changed', new Date(3000))
})

it('freezes route and window and permits different source revisions across resources', async () => {
  const caller = structuredClone(route), sourceWindow = { ...window }, complete = vi.fn()
  const collector = new TradeHistoryCollector({ begin: async () => { caller.login = 'mutated'; return sourceWindow },
    persistPage: async () => { sourceWindow.rangeEndUtcMsc = 9999 }, complete, fail: vi.fn() }, { query: async request => {
    expect(request.route.login).toBe('001')
    expect(request.rangeEndUtcMsc).toBe(2000)
    const page = response(); page.payload.resource = request.resource; page.payload.source_revision = request.resource
    request.route.login = 'mutated-by-provider'
    return page
  } }, () => new Date(3000))
  const result = await collector.collect(caller)
  expect(result.pageChains).toHaveLength(2)
  expect(complete).toHaveBeenCalledWith(route, 2000, new Date(3000), result.pageChains)
})
