import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlSnapshotOpeningOrderOriginReader } from '../src/modules/execution/composition.js'
import { openingOrderTicket } from '../src/modules/execution/domain/opening-order-ticket.js'
const scope = {userId:7,accountId:'11',terminalInstanceId:'terminal-1',brokerServer:'Broker-Demo',login:'00123',connectionEpoch:'3',tickets:['91','92']}
const row = {action_kind:'market_order',user_id:7,account_id:'11',source_type:'risk_decision',source_id:'risk-1',risk_decision_id:'risk-1',trade_decision_id:'decision-1',result_json:{order_ticket:'91',position_ticket:'81'},distribution_strategy_id:null}
function fixture(rows:unknown[]=[row]) {
  const execute=vi.fn().mockResolvedValue([rows]), read=vi.fn().mockResolvedValue({decisionId:'decision-1',userId:7,accountId:'11',strategyId:'21',strategyVersionId:'31'})
  return {execute,read,reader:createMysqlSnapshotOpeningOrderOriginReader({execute} as unknown as PoolConnection,{read})}
}
it('reads market and pending creation with explicit order IDs without current-read locks',async()=>{
  const f=fixture([row,{...row,action_kind:'pending_order',result_json:{order_ticket:'92'}}])
  expect(await f.reader.read(scope)).toEqual(['91','92'].map(ticket=>({ticket,status:'strategy',userId:7,accountId:'11',strategyId:'21',decisionOrigin:{decisionId:'decision-1',riskDecisionId:'risk-1',strategyVersionId:'31'}})))
  expect(f.execute.mock.calls[0]![0]).toContain("i.action_kind IN ('market_order','pending_order')")
  expect(f.execute.mock.calls[0]![0]).not.toContain('FOR SHARE')
  expect(f.read).toHaveBeenCalledOnce()
})
it('does not infer an order ID from a market result position ID or generic ticket',async()=>{
  const f=fixture([{...row,result_json:{ticket:'91',position_ticket:'91',position_id:'92'}}])
  expect(await f.reader.read(scope)).toEqual([{ticket:'91',status:'unresolved'},{ticket:'92',status:'unresolved'}])
  expect(f.read).not.toHaveBeenCalled()
})
it.each(['market_order','pending_order'])('rejects conflicting aliases for %s',action=>{
  expect(()=>openingOrderTicket(action,{order_ticket:'91',order:'92'})).toThrow('opening_order_origin_ticket_ambiguous')
})
it.each([0,Number.MAX_SAFE_INTEGER+1,'0','01','18446744073709551616'])('rejects invalid explicit order ID %s',value=>{
  expect(()=>openingOrderTicket('market_order',{order:value})).toThrow('opening_order_origin_ticket_invalid')
})
it('accepts exact numeric aliases but keeps large IDs as strings',()=>{
  expect(openingOrderTicket('market_order',{order:91,order_ticket:'91'})).toBe('91')
  expect(openingOrderTicket('market_order',{order:'18446744073709551615'})).toBe('18446744073709551615')
})
it('keeps manual and missing origins unresolved',async()=>{
  expect(await fixture([{...row,source_type:'user_command'}]).reader.read(scope)).toEqual([{ticket:'91',status:'unresolved'},{ticket:'92',status:'unresolved'}])
})
it('rejects strategy/manual ambiguity and conflicting strategy evidence',async()=>{
  await expect(fixture([row,{...row,source_type:'user_command'}]).reader.read(scope)).rejects.toThrow('execution_dedup_origin_ambiguous')
  await expect(fixture([row,{...row,source_type:'strategy_distribution',distribution_strategy_id:'22'}]).reader.read(scope)).rejects.toThrow('execution_dedup_origin_ambiguous')
})
it('validates scope before querying',async()=>{
  const f=fixture()
  await expect(f.reader.read({...scope,accountId:'0'})).rejects.toThrow('opening_order_origin_scope_invalid')
  expect(f.execute).not.toHaveBeenCalled()
})

it('rejects two accepted decisions for the same order even when their strategy matches',async()=>{
  const second={...row,source_id:'risk-2',risk_decision_id:'risk-2',trade_decision_id:'decision-2'}
  const f=fixture([row,second])
  f.read.mockImplementation(async input=>({decisionId:input.decisionId,userId:7,accountId:'11',strategyId:'21',strategyVersionId:'31'}))
  await expect(f.reader.read(scope)).rejects.toThrow('opening_order_decision_origin_ambiguous')
})
it('does not attach an AI creation decision to manual distribution, and rejects mixed evidence',async()=>{
  const manual={...row,source_type:'strategy_distribution',distribution_strategy_id:'21'}
  expect((await fixture([manual]).reader.read(scope))[0]).toEqual({ticket:'91',status:'strategy',userId:7,accountId:'11',strategyId:'21'})
  await expect(fixture([row,manual]).reader.read(scope)).rejects.toThrow('opening_order_decision_origin_ambiguous')
})
it('rejects invalid creation versions and retains a defensive copy of a valid decision',async()=>{
  const f=fixture()
  f.read.mockResolvedValue({decisionId:'decision-1',userId:7,accountId:'11',strategyId:'21',strategyVersionId:'0'})
  await expect(f.reader.read(scope)).rejects.toThrow('execution_dedup_origin_invalid')
})
