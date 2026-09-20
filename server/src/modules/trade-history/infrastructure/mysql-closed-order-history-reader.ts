import type { PoolConnection,RowDataPacket } from 'mysql2/promise'
import { ReadClosedOrderHistory, type ClosedOrderFactsReader, type ClosedOrderHistoryReader } from '../application/closed-order-history-reader.js'
import { canonicalEvidence,decodeTerminalHistoryPage } from '../domain/terminal-history-projection.js'
import { createMysqlHistoryWindowCoverageReader } from './mysql-history-window-coverage-reader.js'
import { createMysqlHistoryTaskDealSourceReader } from './mysql-history-task-deal-source-reader.js'

export function createMysqlClosedOrderFactsReader(connection:Pick<PoolConnection,'execute'>):ClosedOrderFactsReader {
  return {async read(input){
    const scope=structuredClone(input)
    if(![scope.accountId,scope.orderTicket].every(value=>/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n))throw Error('closed_order_history_scope_invalid')
    // Existing (account,order,id) index. Do not filter by time/position/side: that would hide conflicting fills.
    const [rows]=await connection.execute<(RowDataPacket&{id:string;ticket:string;occurred_msc:string;fact_hash:string;fact_json:unknown})[]>(`SELECT id,deal_ticket ticket,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',occurred_at_utc) DIV 1000 AS CHAR) occurred_msc,evidence_sha256 fact_hash,evidence_json fact_json
      FROM terminal_history_deals_v4 WHERE trading_account_id=? AND platform='mt5' AND order_ticket=? ORDER BY id LIMIT 1001`,[scope.accountId,scope.orderTicket])
    if(rows.length>1000)throw Error('closed_order_history_capacity_exceeded')
    return rows.map(row=>{
      try{
        const raw:unknown=typeof row.fact_json==='string'?JSON.parse(row.fact_json):structuredClone(row.fact_json)
        if(!raw||typeof raw!=='object'||Array.isArray(raw)||canonicalEvidence(raw as Record<string,unknown>).hash!==row.fact_hash)throw Error('invalid')
        const fact=decodeTerminalHistoryPage('deals',[raw as Record<string,unknown>])[0]
        if(!fact||fact.kind!=='deal'||fact.ticket!==row.ticket||fact.orderTicket!==scope.orderTicket||fact.occurredAtUtcMsc!==Number(row.occurred_msc))throw Error('invalid')
        return {dealId:row.id,fact}
      }catch{throw Error('closed_order_history_fact_corrupt')}
    })
  }}
}
export function createMysqlClosedOrderHistoryReader(connection:Pick<PoolConnection,'execute'>):ClosedOrderHistoryReader {
  return new ReadClosedOrderHistory(createMysqlClosedOrderFactsReader(connection),createMysqlHistoryWindowCoverageReader(connection),createMysqlHistoryTaskDealSourceReader(connection))
}
