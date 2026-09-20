import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { StrategyObserverInventory } from '../src/modules/trading/index.js'
import { createMysqlStrategyReferenceSourceReader } from '../src/modules/inference/infrastructure/mysql-strategy-reference-source-reader.js'

const scope = { userId: 7, analysisId: 'analysis', analysisStrategyId: '10', symbol: 'XAUUSD', asOf: '2026-09-10T00:00:00.000Z' }
function setup(pendingCreation?: Parameters<typeof createMysqlStrategyReferenceSourceReader>[3], positionHistory?: Parameters<typeof createMysqlStrategyReferenceSourceReader>[4], positionCreation?: Parameters<typeof createMysqlStrategyReferenceSourceReader>[5], positionEvidence?: Parameters<typeof createMysqlStrategyReferenceSourceReader>[6], entryAnalyses?: Parameters<typeof createMysqlStrategyReferenceSourceReader>[7]) {
  const connection = { query: vi.fn().mockResolvedValue([]), rollback: vi.fn().mockResolvedValue(undefined), release: vi.fn(), destroy: vi.fn() }
  const source = { analysisId: 'analysis', sourceAccountId: '9', strategyVersionId: '11', snapshotId: 'snapshot', snapshotHash: 'hash' }
  const current = { analysisStrategyId: '10', authorization: { userId: 7, accountId: '9', operatorUserId: 8 },
    observedAt: '2026-09-09T23:59:58.000Z',
    positions: { revision: 5, observedAt: scope.asOf, items: [{ ticket: '92', positionIdentifier: '90', accountId: '9', symbol: 'XAUUSD', side: 'buy', volume: '1', revision: 5 }] },
    route: { platform: 'mt5', userId: 8, accountId: '9', terminalInstanceId: 'terminal', brokerServer: 'Broker', login: '001', connectionEpoch: 4 },
    pendingOrders: { revision: 6, items: [{ ticket: '91' }] } } as StrategyObserverInventory
  const sourceRead = vi.fn().mockResolvedValue(source)
  const inventoryRead = vi.fn().mockResolvedValue(current)
  const sources = vi.fn(() => ({ read: sourceRead }))
  const inventory = vi.fn(() => ({ read: inventoryRead }))
  const pool = { getConnection: vi.fn().mockResolvedValue(connection) } as unknown as Pool
  return { connection, source, current, sourceRead, inventoryRead, sources, inventory,
    reader: createMysqlStrategyReferenceSourceReader(pool, inventory, sources, pendingCreation, positionHistory, positionCreation, positionEvidence, entryAnalyses) }
}

it('reads pending creation on the same connection before rollback and propagates failures', async () => {
  const read = vi.fn().mockResolvedValue([{ ticket: '91', status: 'unresolved' }])
  const factory = vi.fn(() => ({ read })), f = setup(factory)
  expect((await f.reader.read(scope)).pendingOrigins).toEqual([{ ticket: '91', status: 'unresolved' }])
  expect(factory).toHaveBeenCalledWith(f.connection)
  expect(read.mock.invocationCallOrder[0]).toBeLessThan(f.connection.rollback.mock.invocationCallOrder[0]!)
  read.mockRejectedValue(new Error('origin_failed'))
  await expect(f.reader.read(scope)).rejects.toThrow('origin_failed')
  expect(f.connection.rollback).toHaveBeenCalledTimes(2)
  expect(f.connection.release).toHaveBeenCalledTimes(2)
  expect((await setup().reader.read(scope)).pendingOrigins).toBeNull()
})

it('uses one consistent read-only snapshot and the frozen analysis source, then rolls back before release', async () => {
  const f = setup(), input = { ...scope }
  const pending = f.reader.read(input)
  input.userId = 999
  const result = await pending
  expect(f.connection.query.mock.calls).toEqual([
    ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'], ['START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'],
  ])
  expect(f.sources).toHaveBeenCalledWith(f.connection)
  expect(f.inventory).toHaveBeenCalledWith(f.connection)
  expect(f.inventoryRead).toHaveBeenCalledWith({ userId: 7, sourceAccountId: '9', analysisStrategyId: '10', asOf: scope.asOf })
  f.source.sourceAccountId = '99'
  f.current.route.accountId = '99'
  expect(result.source.sourceAccountId).toBe('9')
  expect(result.inventory.route.accountId).toBe('9')
  expect(f.connection.rollback.mock.invocationCallOrder[0]).toBeLessThan(f.connection.release.mock.invocationCallOrder[0]!)
})

it('does not look for substitute inventory when historical source is missing', async () => {
  const f = setup(); f.sourceRead.mockResolvedValue(null)
  await expect(f.reader.read(scope)).rejects.toThrow('strategy_reference_source_unavailable')
  expect(f.inventoryRead).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
})

it.each(['missing', 'viewer', 'source', 'operator', 'strategy'])('rejects unavailable or mismatched inventory: %s', async kind => {
  const f = setup()
  if (kind === 'missing') f.inventoryRead.mockResolvedValue(null)
  if (kind === 'viewer') f.current.authorization.userId = 999
  if (kind === 'source') f.current.route.accountId = '99'
  if (kind === 'operator') f.current.route.userId = 999
  if (kind === 'strategy') f.current.analysisStrategyId = '99'
  await expect(f.reader.read(scope)).rejects.toThrow('strategy_reference_inventory_unavailable')
  expect(f.connection.release).toHaveBeenCalledOnce()
})

it('propagates provider errors and never returns a connection whose rollback failed', async () => {
  const f = setup(); f.inventoryRead.mockRejectedValue(new Error('read_failed'))
  await expect(f.reader.read(scope)).rejects.toThrow('read_failed')
  const broken = setup(); broken.connection.rollback.mockRejectedValue(new Error('rollback_failed'))
  await expect(broken.reader.read(scope)).rejects.toThrow('rollback_failed')
  expect(broken.connection.destroy).toHaveBeenCalledOnce()
  expect(broken.connection.release).not.toHaveBeenCalled()
})

it('destroys a connection when transaction start fails', async () => {
  const f = setup(); f.connection.query.mockRejectedValueOnce(new Error('start_failed'))
  await expect(f.reader.read(scope)).rejects.toThrow('start_failed')
  expect(f.sourceRead).not.toHaveBeenCalled()
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.release).not.toHaveBeenCalled()
})


it('reads position history at its own collection time on the authorized snapshot connection', async () => {
  const read = vi.fn().mockResolvedValue({ status: 'unresolved', reason: 'facts_invalid' })
  const factory = vi.fn(() => ({ read })), f = setup(undefined, factory)
  const result = await f.reader.read(scope)
  expect(factory).toHaveBeenCalledWith(f.connection)
  expect(read).toHaveBeenCalledWith({ accountId: '9', positionIdentifier: '90', symbol: 'XAUUSD',
    side: 'buy', volume: '1', observedAtUtcMsc: Date.parse(scope.asOf) })
  expect(result.positionLifecycles).toEqual({ status: 'read', items: [{ ticket: '92', lifecycle: { status: 'unresolved', reason: 'facts_invalid' } }] })
  expect(read.mock.invocationCallOrder[0]).toBeLessThan(f.connection.rollback.mock.invocationCallOrder[0]!)
  read.mockRejectedValue(new Error('history_failed'))
  await expect(f.reader.read(scope)).rejects.toThrow('history_failed')
  expect(f.connection.rollback).toHaveBeenCalledTimes(2)
})

it.each(['account', 'revision', 'duplicate', 'time'])('rejects malformed position inventory before history access: %s', async kind => {
  const read = vi.fn(), f = setup(undefined, () => ({ read }))
  if (kind === 'account') f.current.positions.items[0]!.accountId = '99'
  if (kind === 'revision') f.current.positions.items[0]!.revision = 99
  if (kind === 'duplicate') f.current.positions.items.push({ ...f.current.positions.items[0]!, ticket: '93' })
  if (kind === 'time') f.current.positions.observedAt = 'invalid'
  await expect(f.reader.read(scope)).rejects.toThrow('strategy_reference_position_lifecycle_invalid')
  expect(read).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})

it('keeps MT4 explicitly unsupported without consulting MT5 history', async () => {
  const read = vi.fn(), f = setup(undefined, () => ({ read }))
  f.current.route.platform = 'mt4'
  expect((await f.reader.read(scope)).positionLifecycles).toEqual({ status: 'unsupported_platform', items: [] })
  expect(read).not.toHaveBeenCalled()
})

it('rejects a matching lifecycle for another position', async () => {
  const read = vi.fn().mockResolvedValue({ status: 'matches_snapshot', positionIdentifier: '99', side: 'buy', volume: '1', contributingOrderTickets: ['81'], dealTickets: ['91'] })
  const f = setup(undefined, () => ({ read }))
  await expect(f.reader.read(scope)).rejects.toThrow('strategy_reference_position_lifecycle_invalid')
})


function creationFixture() {
  const history = vi.fn().mockResolvedValue({status:'matches_snapshot',positionIdentifier:'90',side:'buy',volume:'1',contributingOrderTickets:['81','82'],dealTickets:['91','92']})
  const origins = [{ticket:'81',status:'strategy',userId:8,accountId:'9',strategyId:'20'},
    {ticket:'82',status:'strategy',userId:8,accountId:'9',strategyId:'20'}]
  const read=vi.fn().mockResolvedValue(origins), factory=vi.fn(()=>({read}))
  return {...setup(undefined,()=>({read:history}),factory),history,origins,read,factory}
}
it('reads every contributing opening order on the same authorized snapshot before returning creation evidence',async()=>{
  const f=creationFixture(), result=await f.reader.read(scope)
  expect(result.positionOrigins).toEqual({status:'read',items:[{ticket:'92',status:'creation_strategy_matched',strategyId:'20',orderTickets:['81','82'],creationDecisions:null}]})
  expect(f.factory).toHaveBeenCalledWith(f.connection)
  expect(f.read).toHaveBeenCalledWith({userId:8,accountId:'9',terminalInstanceId:'terminal',brokerServer:'Broker',login:'001',connectionEpoch:'4',tickets:['81','82']})
  expect(f.read.mock.invocationCallOrder[0]).toBeLessThan(f.connection.rollback.mock.invocationCallOrder[0]!)
  f.origins[0]!.strategyId='99'
  expect(result.positionOrigins?.items[0]).toMatchObject({strategyId:'20'})
})
it('does not assign netted positions with multiple strategy origins to either strategy',async()=>{
  const f=creationFixture();f.origins[1]!.strategyId='21'
  expect((await f.reader.read(scope)).positionOrigins).toEqual({status:'read',items:[{ticket:'92',status:'unresolved',reason:'mixed_order_origins'}]})
})
it('keeps missing order origin and unresolved lifecycle separate',async()=>{
  const f=creationFixture()
  f.read.mockResolvedValue([{ticket:'81',status:'unresolved'},{...f.origins[1]}])
  expect((await f.reader.read(scope)).positionOrigins?.items[0]).toMatchObject({status:'unresolved',reason:'order_origin_missing'})
  f.history.mockResolvedValue({status:'unresolved',reason:'snapshot_mismatch'})
  f.read.mockClear()
  expect((await f.reader.read(scope)).positionOrigins?.items[0]).toMatchObject({status:'unresolved',reason:'lifecycle_unresolved'})
  expect(f.read).not.toHaveBeenCalled()
})
it.each(['user','account','missing','duplicate'])('rejects invalid order provider output and rolls back: %s',async kind=>{
  const f=creationFixture()
  if(kind==='user') f.origins[0]!.userId=7
  if(kind==='account') f.origins[0]!.accountId='99'
  if(kind==='missing') f.origins.pop()
  if(kind==='duplicate') f.origins[1]!.ticket='81'
  await expect(f.reader.read(scope)).rejects.toThrow('strategy_reference_pending_creation_invalid')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('propagates origin reader failure without returning partial evidence',async()=>{
  const f=creationFixture();f.read.mockRejectedValue(new Error('origin_failed'))
  await expect(f.reader.read(scope)).rejects.toThrow('origin_failed')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})
it('rejects incomplete composition with no lifecycle reader',()=>{
  expect(()=>setup(undefined,undefined,()=>({read:vi.fn()}))).toThrow('strategy_reference_position_history_required')
})

it('reads full position evidence on the inventory transaction and rolls back on failure', async () => {
  const read = vi.fn().mockResolvedValue({ status: 'unresolved', reason: 'route_unavailable' })
  const factory = vi.fn(() => ({ read })), f = setup(undefined, undefined, undefined, factory)
  expect((await f.reader.read(scope)).positionEvidence).toEqual({ status: 'unresolved', reason: 'route_unavailable' })
  expect(factory).toHaveBeenCalledWith(f.connection)
  expect(read.mock.calls[0]![0]).toEqual(f.current)
  expect(read.mock.calls[0]![0]).not.toBe(f.current)
  expect(read.mock.invocationCallOrder[0]).toBeLessThan(f.connection.rollback.mock.invocationCallOrder[0]!)
  read.mockRejectedValueOnce(new Error('coverage_corrupt'))
  await expect(f.reader.read(scope)).rejects.toThrow('coverage_corrupt')
  expect(f.connection.rollback).toHaveBeenCalledTimes(2)
  expect(f.connection.release).toHaveBeenCalledTimes(2)
})

it('derives creation attribution only from the covered lifecycle when full evidence is configured', async () => {
  const lifecycle = { status: 'matches_snapshot', positionIdentifier: '90', side: 'buy', volume: '1',
    contributingOrderTickets: ['81'], dealTickets: ['82'] }
  const readEvidence = vi.fn().mockResolvedValue({ status: 'read', items: [{ ticket: '92', history: {
    status: 'source_matched', lifecycle, taskId: 'task', receiptId: 'receipt', completionHash: 'hash', deals: [] } }] })
  const legacyRead = vi.fn().mockRejectedValue(new Error('must_not_read_quantity_only_path'))
  const readOrigins = vi.fn().mockResolvedValue([{ ticket: '81', status: 'strategy', userId: 8, accountId: '9', strategyId: '12' }])
  const f = setup(undefined, () => ({ read: legacyRead }), () => ({ read: readOrigins }), () => ({ read: readEvidence }))
  expect((await f.reader.read(scope)).positionOrigins).toMatchObject({ status: 'read', items: [{ ticket: '92', status: 'creation_strategy_matched', strategyId: '12' }] })
  expect(legacyRead).not.toHaveBeenCalled()
  readOrigins.mockClear()
  readEvidence.mockResolvedValue({ status: 'read', items: [{ ticket: '92', history: { status: 'unresolved', reason: 'coverage_unavailable' } }] })
  expect((await f.reader.read(scope)).positionOrigins).toEqual({ status: 'read', items: [{ ticket: '92', status: 'unresolved', reason: 'lifecycle_unresolved' }] })
  expect(readOrigins).not.toHaveBeenCalled()
})
it.each([{items:[]}, {items:[{ticket:'999',history:{status:'unresolved',reason:'source_missing'}}]}])('rejects incomplete or foreign position evidence sets', async ({items}) => {
  const f = setup(undefined,undefined,undefined,() => ({read:vi.fn().mockResolvedValue({status:'read',items})}))
  await expect(f.reader.read(scope)).rejects.toThrow('strategy_reference_position_evidence_invalid')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})

it('retains each netting contribution decision and version instead of choosing the latest strategy',async()=>{
  const f=creationFixture()
  const rows=f.origins.map((row,index)=>({...row,decisionOrigin:{decisionId:`decision-${index}`,riskDecisionId:`risk-${index}`,strategyVersionId:String(31+index)}}))
  f.read.mockResolvedValue(rows)
  const result=await f.reader.read(scope)
  expect(result.positionOrigins?.items[0]).toMatchObject({creationDecisions:rows.map(row=>({...row.decisionOrigin,orderTicket:row.ticket}))})
  rows[0]!.decisionOrigin.strategyVersionId='99'
  expect(result.positionOrigins?.items[0]).toMatchObject({creationDecisions:[{orderTicket:'81',strategyVersionId:'31'},{orderTicket:'82',strategyVersionId:'32'}]})
  f.read.mockResolvedValue([rows[0],f.origins[1]])
  expect((await f.reader.read(scope)).positionOrigins?.items[0]).toMatchObject({creationDecisions:null})
})

it('reads historical entry analyses on the same snapshot connection before rollback',async()=>{
  const history={status:'matches_snapshot' as const,positionIdentifier:'90',side:'buy' as const,volume:'1',contributingOrderTickets:['81'],dealTickets:['91']}
  const creation={ticket:'81',status:'strategy' as const,userId:8,accountId:'9',strategyId:'20',decisionOrigin:{decisionId:'d1',riskDecisionId:'r1',strategyVersionId:'31'}}
  const read=vi.fn(async request=>({...request,analysisId:'old-analysis'})), factory=vi.fn(()=>({read}))
  const f=setup(undefined,()=>({read:async()=>history}),()=>({read:async()=>[creation]}),undefined,factory)
  const result=await f.reader.read(scope)
  expect(factory).toHaveBeenCalledWith(f.connection)
  expect(read.mock.invocationCallOrder[0]).toBeLessThan(f.connection.rollback.mock.invocationCallOrder[0]!)
  expect(result.positionEntryAnalyses).toMatchObject([{ticket:'92',status:'read',entries:[{orderTicket:'81',analysis:{analysisId:'old-analysis',userId:8,strategyVersionId:'31'}}]}])
  read.mockRejectedValueOnce(Error('entry_read_failed'))
  await expect(f.reader.read(scope)).rejects.toThrow('entry_read_failed')
  expect(f.connection.rollback).toHaveBeenCalledTimes(2)
})
