import { evaluatePartialCloseProtection } from '../src/modules/execution/domain/partial-close-protection.js'
import { describe,expect,it,vi } from 'vitest'
import { reconcileClosedOrderFills } from '../src/modules/trade-history/domain/closed-order-fills.js'
import { decodeTerminalHistoryPage,type TerminalDealFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import { ReadClosedOrderHistory } from '../src/modules/trade-history/application/closed-order-history-reader.js'
import type { HistoryTaskCoverageResult } from '../src/modules/trade-history/application/history-task-coverage-reader.js'
import type { HistoryTaskDealSourceResult } from '../src/modules/trade-history/application/history-task-deal-source-reader.js'
import { createPartialCloseHistoryProofReader } from '../src/bootstrap/partial-close-history-proof.js'

const route={userId:7,accountId:'5',platform:'mt5' as const,brokerServer:'Broker',login:'42',terminalInstanceId:'terminal',terminalProfileId:'profile',
  connectionId:'connection',connectionEpoch:2,sessionId:'session',timezoneOffsetMinutes:180,ownershipRevision:'1'}
const scope={route,orderTicket:'201',receiptDealTickets:['301'],positionIdentifier:'100',symbol:'XAUUSD',positionSide:'buy' as const,
  expectedVolume:'0.08',issuedAtUtcMsc:1000,completedAtUtcMsc:2000}
function deal(ticket='301',volume='0.08'):TerminalDealFact {
  return decodeTerminalHistoryPage('deals',[{ticket,order:'201',position_id:'100',symbol:'XAUUSD',type:'sell',entry:'out',time_msc:1500,volume}])[0] as TerminalDealFact
}
describe('closed order fill reconciliation',()=>{
  it('sums multiple fills exactly and keeps fee records out of exposure',()=>{
    const fee={...deal('303','0'),dealKind:'fee' as const,entryKind:'none' as const,side:'none' as const,positionId:null,symbol:null}
    expect(reconcileClosedOrderFills(scope,[deal('301','0.03'),deal('302','0.05'),fee]))
      .toEqual({closedVolume:'0.08',tradeDealTickets:['301','302'],lastDealAtUtcMsc:1500})
    expect(reconcileClosedOrderFills({...scope,expectedVolume:'9007199254740993.00000002'},[
      deal('301','9007199254740993.00000001'),deal('302','0.00000001')])).toMatchObject({closedVolume:'9007199254740993.00000002'})
  })
  it.each([{volume:'0.07'},{volume:'0.09'},{entryKind:'in' as const},{entryKind:'inout' as const},{entryKind:'out_by' as const},
    {side:'buy' as const},{positionId:'999'},{orderTicket:'202'},{symbol:'EURUSD'},{occurredAtUtcMsc:999},{occurredAtUtcMsc:2001},
    {dealKind:'correction' as const}])('rejects wrong close facts %j',patch=>{
    expect(reconcileClosedOrderFills(scope,[{...deal(),...patch}])).toBeNull()
  })
  it('requires receipt deals among closing fills, not just an equal aggregate',()=>{
    expect(reconcileClosedOrderFills(scope,[deal('999')])).toBeNull()
    expect(reconcileClosedOrderFills(scope,[deal(),deal()])).toBeNull()
    const fee={...deal('301','0'),dealKind:'fee' as const,entryKind:'none' as const,side:'none' as const}
    expect(reconcileClosedOrderFills(scope,[deal('302'),fee])).toBeNull()
  })
  it('does not silently ignore fee-shaped quantity changes',()=>{
    const fee={...deal('302','0.01'),dealKind:'fee' as const,entryKind:'none' as const,side:'none' as const}
    expect(reconcileClosedOrderFills(scope,[deal(),fee])).toBeNull()
  })
})
function fixture(){
  const fact=deal(),rows=[{dealId:'deal-id',fact}]
  const coverage:Extract<HistoryTaskCoverageResult,{status:'provider_asserted'}>={status:'provider_asserted',taskId:'task',receiptId:'receipt',completionHash:'a'.repeat(64),
    rangeStartUtcMsc:900,rangeEndUtcMsc:2100,resources:[{resource:'history.deals',source:'terminal',sourceRevision:'rev',rangeStartUtcMsc:900,rangeEndUtcMsc:2100,
      pageCount:1,itemCount:1,pageChainHash:'b'.repeat(64),pageMembership:{version:1,pages:[]} as unknown as NonNullable<Extract<HistoryTaskCoverageResult,{status:'provider_asserted'}>['resources'][number]['pageMembership']>,
      historyCoverage:{version:1,status:'complete',range_start_utc_msc:900,range_end_utc_msc:2100,source_revision:'rev',collected_at_utc_msc:2200}}]}
  const proof:Extract<HistoryTaskDealSourceResult,{status:'source_matched'}>={status:'source_matched',taskId:'task',receiptId:'receipt',completionHash:'a'.repeat(64),
    deals:[{ticket:fact.ticket,dealId:'deal-id',factHash:fact.evidenceHash,provenanceHashes:['c'.repeat(64)]}]}
  const facts=vi.fn(async()=>rows),cover=vi.fn(async():Promise<HistoryTaskCoverageResult>=>coverage),sources=vi.fn(async():Promise<HistoryTaskDealSourceResult>=>proof)
  return {fact,rows,coverage,proof,facts,cover,sources,reader:new ReadClosedOrderHistory({read:facts},{read:cover},{read:sources})}
}
describe('complete source-backed close history',()=>{
  it('binds one covering task to the exact fact identity and hash',async()=>{
    const f=fixture(),result=await f.reader.read(scope)
    expect(result).toMatchObject({status:'matched',closedVolume:'0.08',orderTicket:'201',positionIdentifier:'100',taskId:'task'})
    expect(f.sources).toHaveBeenCalledWith({taskId:'task',route,dealTickets:['301']})
    expect(f.cover).toHaveBeenCalledWith({route,rangeStartUtcMsc:999,rangeEndUtcMsc:2000})
  })
  it('does not use facts without explicit complete history coverage',async()=>{
    const f=fixture();f.cover.mockResolvedValueOnce({status:'unresolved',reason:'coverage_missing'})
    expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'coverage_unavailable'})
    expect(f.facts).not.toHaveBeenCalled()
    delete f.coverage.resources[0]!.pageMembership
    expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'coverage_unavailable'})
  })
  it('requires every fill to have matching source evidence',async()=>{
    const f=fixture();f.sources.mockResolvedValueOnce({status:'unresolved',reason:'source_missing'})
    expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'source_missing'})
  })
  it.each(['taskId','receiptId','completionHash'] as const)('rejects a different source proof %s',async key=>{
    const f=fixture();f.proof[key]='other'
    await expect(f.reader.read(scope)).rejects.toThrow('closed_order_history_source_mismatch')
  })
  it.each(['dealId','factHash','ticket'] as const)('rejects an unrelated source fact %s',async key=>{
    const f=fixture();f.proof.deals[0]![key]='other'
    await expect(f.reader.read(scope)).rejects.toThrow('closed_order_history_source_mismatch')
  })
  it('rejects missing, duplicated or empty source entries',async()=>{
    for(const kind of ['missing','duplicate','empty']){
      const f=fixture()
      if(kind==='missing')f.proof.deals=[]
      if(kind==='duplicate')f.proof.deals.push({...f.proof.deals[0]!})
      if(kind==='empty')f.proof.deals[0]!.provenanceHashes=[]
      await expect(f.reader.read(scope)).rejects.toThrow('closed_order_history_source_mismatch')
    }
  })
  it('rejects MT4 and mismatched time coverage',async()=>{
    const f=fixture();expect(await f.reader.read({...scope,route:{...route,platform:'mt4'}})).toEqual({status:'unresolved',reason:'unsupported_platform'})
    f.coverage.rangeEndUtcMsc=1999
    await expect(f.reader.read(scope)).rejects.toThrow('closed_order_history_coverage_mismatch')
  })
  it('joins the exact command receipt to source-backed history without allowing dispatch',async()=>{
    const f=fixture(),target={userId:'7',accountId:'5',terminalInstanceId:'terminal',brokerServer:'Broker',login:'42',positionIdentifier:'100',ticket:'101',symbol:'XAUUSD',side:'buy' as const}
    const plan={workflowId:'workflow',parentIntentId:'intent',parentCommandId:'command',target,initialVolume:'0.10',closeVolume:'0.08',initialRevision:5,expiresAt:3000,protection:{stopLoss:'2400'}}
    const receipt={parentIntentId:'intent',parentCommandId:'command',target,issuedAt:1000,completedAt:2000,connectionEpoch:1,
      resultHash:'d'.repeat(64),orderTicket:'201',dealTickets:['301']}
    const receipts={read:vi.fn(async()=>receipt)}
    const reader=createPartialCloseHistoryProofReader(receipts,f.reader,route)
    const result=await reader.read(plan)
    expect(result).toMatchObject({parentIntentId:'intent',parentCommandId:'command',target,closedVolume:'0.08',completedAt:2000,
      evidence:{orderTicket:'201',resultHash:'d'.repeat(64),taskId:'task'}})
    expect(result!.evidenceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(evaluatePartialCloseProtection({plan,parentState:'succeeded',history:result,now:2100,maxProjectionAgeMs:100,
      projection:{route:target,complete:true,revision:6,observedAt:2050,positions:[{target,volume:'0.02'}]}}).state).toBe('risk_review_required')
    const matched=await f.reader.read(scope)
    if(matched.status!=='matched')throw Error('fixture')
    const wrongQuantity=createPartialCloseHistoryProofReader(receipts,{read:async()=>({...matched,closedVolume:'0.07'})},route)
    await expect(wrongQuantity.read(plan)).rejects.toThrow('partial_close_history_facts_mismatch')
    receipt.connectionEpoch=3
    await expect(reader.read(plan)).rejects.toThrow('partial_close_history_receipt_mismatch')
  })
})
