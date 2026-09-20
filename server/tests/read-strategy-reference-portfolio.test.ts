import { expect, it, vi } from 'vitest'
import { ReadStrategyReferencePortfolio, type StrategyReferenceEvidence } from '../src/modules/inference/application/read-strategy-reference-portfolio.js'
import { freezeStrategyReferencePortfolio } from '../src/modules/inference/application/strategy-reference-portfolio.js'
const scope={analysisId:'11111111-1111-4111-8111-111111111111',userId:7,targetAccountId:'8',analysisStrategyId:'20',traderStrategyId:'21',symbol:'XAUUSD',asOf:'2026-09-10T00:00:00.000Z'}
function fixture() {
  const inventory={analysisStrategyId:'20',route:{accountId:'9',userId:70,platform:'mt5'},observedAt:scope.asOf,
    authorization:{userId:7,accountId:'9',operatorUserId:70,expiresAtUtc:'2026-09-10T00:01:00.000Z'},
    positions:{revision:2,observedAt:scope.asOf,items:[{ticket:'12345',accountId:'9',positionIdentifier:'90',symbol:'XAUUSD',side:'buy',volume:'1',openPrice:'2500',stopLoss:null,takeProfit:'2600',revision:2}]},
    pendingOrders:{revision:3,items:[{ticket:'23456',accountId:'9',symbol:'XAUUSD',type:'buy_limit',volume:'1',price:'2400',stopLoss:null,takeProfit:null,expiresAt:null,revision:3}]}}
  const data={source:{analysisId:scope.analysisId,sourceAccountId:'9'},inventory,
    pendingOrigins:[{ticket:'23456',status:'strategy',userId:70,accountId:'9',strategyId:'21'}],
    positionOrigins:{status:'read',items:[{ticket:'12345',status:'creation_strategy_matched',strategyId:'21',orderTickets:['81'],creationDecisions:null}]},
    positionEvidence:{status:'read',items:[{ticket:'12345',history:{status:'source_matched',taskId:'task',receiptId:'receipt',completionHash:'hash',deals:[],
      lifecycle:{status:'matches_snapshot',positionIdentifier:'90',side:'buy',volume:'1',contributingOrderTickets:['81'],dealTickets:['82']}}}]}}
  const read=vi.fn().mockImplementation(async()=>data as unknown as StrategyReferenceEvidence)
  return {data,read,reader:new ReadStrategyReferencePortfolio({read},()=>new Date(scope.asOf))}
}
it('freezes the exact strategy reference portfolio with opaque non-executable IDs',async()=>{
  const f=fixture(),result=await freezeStrategyReferencePortfolio(scope,f.reader)
  expect(result).toMatchObject({state:'ready',purpose:'strategy_reference_only',sourceAccountId:'9',positionsRevision:2,pendingOrdersRevision:3,
    positions:[{side:'buy',volume:'1',entryPrice:'2500'}],pendingOrders:[{orderType:'buy_limit',entryPrice:'2400'}]})
  expect(JSON.stringify(result)).not.toContain('12345');expect(JSON.stringify(result)).not.toContain('23456')
  expect(JSON.stringify(result)).not.toContain('taskId')
  expect(f.read).toHaveBeenCalledWith(scope)
  expect(f.data.inventory.positions.items[0]!.ticket).toBe('12345')
})
it('excludes confirmed other strategies without changing account inventory',async()=>{
  const f=fixture();f.data.pendingOrigins[0]!.strategyId='22';f.data.positionOrigins.items[0]!.strategyId='22'
  expect(await f.reader.read(scope)).toMatchObject({state:'ready',positions:[],pendingOrders:[]})
  expect(f.data.inventory.positions.items).toHaveLength(1)
})
it('does not apply another symbol to this reference portfolio',async()=>{
  const f=fixture();f.data.inventory.positions.items[0]!.symbol='EURUSD';f.data.inventory.pendingOrders.items[0]!.symbol='EURUSD'
  expect(await f.reader.read(scope)).toMatchObject({positions:[],pendingOrders:[]})
})
it.each(['history','origin','orders','pending','source','viewer','expiry','stale','missing'])('rejects unresolved or mismatched evidence: %s',async kind=>{
  const f=fixture()
  if(kind==='history')f.data.positionEvidence.items[0]!.history.status='unresolved'
  if(kind==='origin')f.data.positionOrigins.items[0]!.status='unresolved'
  if(kind==='orders')f.data.positionOrigins.items[0]!.orderTickets=['99']
  if(kind==='pending')f.data.pendingOrigins[0]!.status='unresolved'
  if(kind==='source')f.data.source.sourceAccountId='99'
  if(kind==='viewer')f.data.inventory.authorization.userId=8
  if(kind==='expiry')f.data.inventory.authorization.expiresAtUtc=scope.asOf
  if(kind==='stale')f.data.inventory.observedAt='2026-09-09T23:59:29.999Z'
  if(kind==='missing')f.data.positionEvidence.items=[]
  await expect(f.reader.read(scope)).rejects.toThrow('strategy_reference_portfolio_unavailable')
})
it('rejects expiry during the source read rather than accepting the start time',async()=>{
  const f=fixture(),reader=new ReadStrategyReferencePortfolio({read:f.read},()=>new Date('2026-09-10T00:01:01.000Z'))
  await expect(reader.read(scope)).rejects.toThrow('strategy_reference_portfolio_unavailable')
})
it('propagates source read failures instead of fabricating an empty portfolio',async()=>{
  const f=fixture();f.read.mockRejectedValue(new Error('source_failed'))
  await expect(f.reader.read(scope)).rejects.toThrow('source_failed')
})

it.each(['XAUUSD.s', 'XAUUSD.c', 'xauusd.any_suffix'])('includes broker suffix %s without rewriting source tickets or symbols', async symbol => {
  const f = fixture()
  f.data.inventory.positions.items[0]!.symbol = symbol
  f.data.inventory.pendingOrders.items[0]!.symbol = symbol
  const result = await f.reader.read(scope)
  expect(result).toMatchObject({ state: 'ready' })
  expect(result.positions).toHaveLength(1)
  expect(result.pendingOrders).toHaveLength(1)
  expect(f.data.inventory.positions.items[0]).toMatchObject({ symbol, ticket: '12345' })
})
it('still rejects unresolved origins when the instrument carries a suffix', async () => {
  const f = fixture()
  f.data.inventory.positions.items[0]!.symbol = 'XAUUSD.s'
  f.data.positionOrigins.items[0]!.status = 'unresolved'
  await expect(f.reader.read(scope)).rejects.toThrow('strategy_reference_portfolio_unavailable')
})
