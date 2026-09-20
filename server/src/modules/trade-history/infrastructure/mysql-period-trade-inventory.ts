import type { HistoryTaskDealInventoryPage } from '../application/history-task-deal-inventory-reader.js'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/index.js'
import { createMysqlHistoryTaskDealInventoryPageReader } from './mysql-history-task-deal-inventory-reader.js'
import { decodeTerminalHistoryPage } from '../domain/terminal-history-projection.js'
import { provenHistoryRecordSql } from './trade-history-ownership-sql.js'

/** Caller owns the transaction. Discovery checks all closing deals, not just existing review cases. */
export function createMysqlPeriodTradeInventory(connection: PoolConnection) {
  const tasks=createMysqlHistoryTaskDealInventoryPageReader(connection)
  return {async read(input:{taskId:string;route:BridgeGatewayRoute;startUtcMsc:number;endUtcMsc:number;asOfUtcMsc:number}) {
    const scope=structuredClone(input)
    if(![scope.startUtcMsc,scope.endUtcMsc,scope.asOfUtcMsc].every(v=>Number.isSafeInteger(v)&&v>0)
      || scope.startUtcMsc>=scope.endUtcMsc || scope.endUtcMsc>scope.asOfUtcMsc) throw Error('period_inventory_scope_invalid')
    let inventory:Extract<HistoryTaskDealInventoryPage,{status:'inventory_page'}>|null=null
    let afterHash:string|null=null
    const exits:Extract<HistoryTaskDealInventoryPage,{status:'inventory_page'}>['facts']=[],tickets=new Set<string>()
    do {
      const page:HistoryTaskDealInventoryPage=await tasks.read({taskId:scope.taskId,route:scope.route,afterHash,
        completionHash:inventory?.completionHash??null,limit:500})
      if(page.status!=='inventory_page')return page
      if(page.rangeStartUtcMsc>scope.startUtcMsc || page.rangeEndUtcMsc<scope.asOfUtcMsc) {
        return {status:'unresolved' as const,reason:'period_collection_window_incomplete'}
      }
      if(inventory && (page.receiptId!==inventory.receiptId || page.rangeStartUtcMsc!==inventory.rangeStartUtcMsc
        || page.rangeEndUtcMsc!==inventory.rangeEndUtcMsc)) throw Error('history_inventory_cursor_changed')
      inventory={...page,facts:[]}
      for(const f of page.facts) {
        if(tickets.has(f.ticket))return {status:'unresolved' as const,reason:'period_deal_link_ambiguous'}
        tickets.add(f.ticket)
        const fact=decodeTerminalHistoryPage('deals',[f.raw])[0]
        if(fact?.kind==='deal' && fact.dealKind==='trade' && ['out','out_by','inout'].includes(fact.entryKind)
          && fact.occurredAtUtcMsc>=scope.startUtcMsc && fact.occurredAtUtcMsc<scope.endUtcMsc)exits.push(f)
      }
      afterHash=page.nextHash
    } while(afterHash!==null)
    const sqlTime=(v:number)=>new Date(v).toISOString().slice(0,23).replace('T',' ')
    const [rows]=await connection.execute<RowDataPacket[]>(`SELECT r.id,r.revision,r.source_classification,r.attribution_status,
      r.evidence_sha256,r.account_currency,r.currency_evidence,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',r.closed_at_utc) DIV 1000 AS CHAR) closed_msc
      FROM account_trade_records_v4 r WHERE r.user_id=? AND r.trading_account_id=? AND r.platform='mt5'
        AND r.status='closed' AND r.closed_at_utc>=? AND r.closed_at_utc<? AND ${provenHistoryRecordSql()}
      ORDER BY r.id LIMIT 1001 FOR SHARE`,[scope.route.userId,scope.route.accountId,sqlTime(scope.startUtcMsc),sqlTime(scope.endUtcMsc)])
    if(rows.length>1000) return {status:'unresolved' as const,reason:'period_inventory_limit'}
    const ids=rows.map(r=>String(r.id)), covered=new Map<string,string>(), owners=new Map<string,string>()
    if(ids.length){
      const [links]=await connection.execute<RowDataPacket[]>(`SELECT x.trade_record_id,d.id,d.evidence_sha256 FROM account_trade_record_deals_v4 x
        JOIN terminal_history_deals_v4 d ON d.id=x.terminal_deal_id AND d.trading_account_id=? AND d.platform='mt5'
        WHERE x.trade_record_id IN (${ids.map(()=>'?').join(',')}) LIMIT 10001 FOR SHARE`,[scope.route.accountId,...ids])
      if(links.length>10000) return {status:'unresolved' as const,reason:'period_inventory_limit'}
      for(const link of links){
        if(covered.has(String(link.id))) return {status:'unresolved' as const,reason:'period_deal_link_ambiguous'}
        covered.set(String(link.id),String(link.evidence_sha256))
        owners.set(String(link.id),String(link.trade_record_id))
      }
    }
    if(exits.some(f=>covered.get(f.id)!==f.hash)) return {status:'unresolved' as const,reason:'period_closing_deal_unrepresented'}
    const represented=new Set(exits.map(f=>owners.get(f.id)))
    if(ids.some(id=>!represented.has(id))) return {status:'unresolved' as const,reason:'period_record_closure_unproven'}
    return {status:'captured' as const,inventory:{accountId:scope.route.accountId,rangeStartUtcMsc:inventory.rangeStartUtcMsc,
      rangeEndUtcMsc:inventory.rangeEndUtcMsc,asOfUtcMsc:scope.asOfUtcMsc,completionHash:inventory.completionHash,
      records:rows.map(r=>({id:String(r.id),revision:Number(r.revision),closedAtUtcMsc:Number(r.closed_msc),
        source:r.source_classification as 'system'|'manual'|'other_ea'|'mixed'|'unknown',
        attribution:r.attribution_status as 'exact'|'partial'|'unresolved',evidenceHash:String(r.evidence_sha256),
        accountCurrency:r.currency_evidence==='explicit_record'?r.account_currency as string|null:null}))}}
  }}
}
