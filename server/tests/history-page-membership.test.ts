import { expect, it } from 'vitest'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../src/modules/bridge/index.js'
import { HistoryPageChain } from '../src/modules/trade-history/application/history-page-chain.js'
import { assertHistoryPageMembership } from '../src/modules/trade-history/application/history-page-membership.js'
const route = { userId: 7, accountId: '42', platform: 'mt5', timezoneOffsetMinutes: 180, terminalProfileId: 'profile_12345678',
  terminalInstanceId: 'terminal_12345678', brokerServer: 'Broker', login: '001', connectionEpoch: 3,
  connectionId: 'connection_12345678', sessionId: 'session_12345678' } satisfies BridgeGatewayRoute
function page(index: number, more = false, count = 1): BridgeQueryResponseEnvelope {
  return {v:4,type:'query.response',message_id:`response_${index}`,correlation_id:`message_${index}`,sent_at_utc_msc:3000,
    route:{terminal_instance_id:route.terminalInstanceId,account_ref:{broker_server:route.brokerServer,login:route.login},connection_epoch:3},
    payload:{request_id:`request_${index}`,resource:'history.deals',source:'terminal',source_revision:'revision_1',observed_at_utc_msc:3000,
      items:Array.from({length:count},(_,i)=>({ticket:String(index*1000+i+1)})),has_more:more,next_cursor:more?`cursor_${index+1}`:null}}
}
function chain() {return new HistoryPageChain(route,{rangeStartUtcMsc:1000,rangeEndUtcMsc:2000},'history.deals')}
it('retains exact response identities and sorted unique original item hashes in an immutable result',()=>{
  const c=chain(),p=page(1);p.payload.items.push({...p.payload.items[0]})
  c.append(null,p);const result=c.finish()
  expect(()=>assertHistoryPageMembership(route,result)).not.toThrow()
  expect(result.pageMembership?.pages[0]).toMatchObject({requestId:'request_1',responseMessageId:'response_1',queryMessageId:'message_1',itemCount:2})
  expect(result.pageMembership?.pages[0]?.factHashes).toHaveLength(1)
  result.pageMembership!.pages[0]!.factHashes=[]
  expect(c.finish().pageMembership!.pages[0]!.factHashes).toHaveLength(1)
})
it.each(['digest','count','hash','cursor','identity','empty'])('rejects malformed membership: %s',kind=>{
  const c=chain();c.append(null,page(1));const result=c.finish(),p=result.pageMembership!.pages[0]!
  if(kind==='digest')p.responseHash='f'.repeat(64)
  if(kind==='count')p.itemCount++
  if(kind==='hash')p.factHashes=['bad']
  if(kind==='cursor')p.requestedCursor='unexpected'
  if(kind==='identity')p.requestId=''
  if(kind==='empty')result.pageMembership!.pages=[]
  expect(()=>assertHistoryPageMembership(route,result)).toThrow('history_page_membership_invalid')
})
it('omits the entire proof above its bound while preserving ordinary traversal',()=>{
  const c=chain()
  for(let i=0;i<21;i++)c.append(i===0?null:`cursor_${i}`,page(i,i<20,500))
  expect(c.finish().itemCount).toBe(10500)
  expect(c.finish()).not.toHaveProperty('pageMembership')
})
it('accepts old chains without changing their representation',()=>{
  const c=chain();c.append(null,page(1));const result=c.finish();delete result.pageMembership
  expect(()=>assertHistoryPageMembership(route,result)).not.toThrow()
  expect(result).not.toHaveProperty('pageMembership')
})

it('reconstructs a task after credential proof fields are removed from its stored route',()=>{
  const full={...route,installationId:'installation_1',credentialGeneration:3}
  const c=new HistoryPageChain(full,{rangeStartUtcMsc:1000,rangeEndUtcMsc:2000},'history.deals')
  c.append(null,page(1))
  expect(()=>assertHistoryPageMembership(route,c.finish())).not.toThrow()
  expect(()=>assertHistoryPageMembership({...route,sessionId:'different_session'},c.finish())).toThrow('history_page_membership_invalid')
})
