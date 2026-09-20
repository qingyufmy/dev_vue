import { expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { HistoryTaskCoverageReader } from '../src/modules/trade-history/application/history-task-coverage-reader.js'
import type { HistoryTaskDealSourceReader } from '../src/modules/trade-history/application/history-task-deal-source-reader.js'
import { canonicalEvidence } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import { createMysqlHistoryTaskDealInventoryPageReader, createMysqlHistoryTaskDealInventoryReader } from '../src/modules/trade-history/infrastructure/mysql-history-task-deal-inventory-reader.js'

function fixture() {
  const rows=Array.from({length:1001},(_,i)=>{
    const raw={ticket:String(i+1),type:'buy',entry:'in',time_msc:1789000000000,volume:'1',price:'2500',symbol:'XAUUSD'}
    return {id:`deal-${i}`,ticket:raw.ticket,hash:canonicalEvidence(raw).hash,raw}
  })
  const deleted=new Set<string>(),sizes:number[]=[],completionHash='a'.repeat(64)
  const connection={async execute(_sql:string,params:unknown[]){
    const hashes=params.slice(1);sizes.push(hashes.length)
    return [rows.filter(row=>hashes.includes(row.hash)&&!deleted.has(row.hash))]
  }} as unknown as PoolConnection
  const coverage:HistoryTaskCoverageReader={async read(){return {status:'provider_asserted',taskId:'task',receiptId:'receipt',completionHash,
    rangeStartUtcMsc:1788990000000,rangeEndUtcMsc:1789010000000,resources:[{resource:'history.deals',pageMembership:{pages:[{factHashes:rows.map(row=>row.hash)}]},historyCoverage:{}}]} as unknown as Awaited<ReturnType<HistoryTaskCoverageReader['read']>> }}
  const sources:HistoryTaskDealSourceReader={async read(input){return {status:'source_matched',taskId:'task',receiptId:'receipt',completionHash,
    deals:rows.filter(row=>input.dealTickets.includes(row.ticket)).map(row=>({dealId:row.id,ticket:row.ticket,factHash:row.hash,provenanceHashes:['b'.repeat(64)]}))} as Awaited<ReturnType<HistoryTaskDealSourceReader['read']>> }}
  return {rows,deleted,sizes,connection,dependencies:{coverage,sources},scope:{taskId:'task',route:{platform:'mt5',accountId:'5'} as BridgeGatewayRoute},completionHash}
}
it('verifies more than 1000 task facts in bounded batches without gaps or duplicates',async()=>{
  const f=fixture(),reader=createMysqlHistoryTaskDealInventoryPageReader(f.connection,f.dependencies)
  let afterHash:string|null=null,completionHash:string|null=null
  const seen:string[]=[]
  do {
    const page=await reader.read({...f.scope,afterHash,completionHash,limit:500})
    expect(page.status).toBe('inventory_page');if(page.status!=='inventory_page')throw Error('unexpected')
    seen.push(...page.facts.map(row=>row.ticket));afterHash=page.nextHash;completionHash=page.completionHash
  }while(afterHash!==null)
  expect(new Set(seen).size).toBe(1001);expect(seen.length).toBe(1001);expect(f.sizes).toEqual([500,500,1])
})
it('rejects a different completion snapshot or deleted later-page fact',async()=>{
  const f=fixture(),reader=createMysqlHistoryTaskDealInventoryPageReader(f.connection,f.dependencies)
  const page=await reader.read({...f.scope,afterHash:null,completionHash:null,limit:500})
  if(page.status!=='inventory_page')throw Error('unexpected')
  await expect(reader.read({...f.scope,afterHash:page.nextHash,completionHash:'c'.repeat(64),limit:500})).rejects.toThrow('history_inventory_cursor_changed')
  const last=[...f.rows].sort((a,b)=>a.hash.localeCompare(b.hash))[700]!
  f.deleted.add(last.hash)
  expect(await reader.read({...f.scope,afterHash:page.nextHash,completionHash:f.completionHash,limit:500})).toMatchObject({status:'unresolved',reason:'inventory_missing'})
})
it('keeps the bounded one-shot consumer explicit rather than returning a partial inventory',async()=>{
  const f=fixture()
  expect(await createMysqlHistoryTaskDealInventoryReader(f.connection,f.dependencies).read(f.scope)).toMatchObject({status:'unresolved',reason:'inventory_limit'})
})
