import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { TerminalDealFact } from '../domain/terminal-history-projection.js'
import { reconcileClosedOrderFills, type ClosedOrderFillScope } from '../domain/closed-order-fills.js'
import type { HistoryWindowCoverageReader } from './history-window-coverage-reader.js'
import type { HistoryTaskDealSourceReader } from './history-task-deal-source-reader.js'

export interface ClosedOrderHistoryScope extends ClosedOrderFillScope { readonly route:BridgeGatewayRoute }
export type ClosedOrderHistoryResult =
  | {status:'unresolved';reason:'unsupported_platform'|'coverage_unavailable'|'fills_mismatch'|'source_missing'}
  | {status:'matched';orderTicket:string;positionIdentifier:string;closedVolume:string;lastDealAtUtcMsc:number;
      taskId:string;receiptId:string;completionHash:string;
      deals:Array<{ticket:string;dealId:string;factHash:string;provenanceHashes:string[]}>}
export interface ClosedOrderHistoryReader { read(scope:ClosedOrderHistoryScope):Promise<ClosedOrderHistoryResult> }
export interface ClosedOrderFactsReader {
  read(scope:{accountId:string;orderTicket:string}):Promise<readonly {dealId:string;fact:TerminalDealFact}[]>
}

/** All ports share the caller's authorized consistent snapshot. No latest-position or comment-based attribution. */
export class ReadClosedOrderHistory implements ClosedOrderHistoryReader {
  constructor(private readonly facts:ClosedOrderFactsReader,private readonly coverage:HistoryWindowCoverageReader,private readonly sources:HistoryTaskDealSourceReader){}
  async read(input:ClosedOrderHistoryScope):Promise<ClosedOrderHistoryResult>{
    const scope=structuredClone(input)
    if(scope.route.platform!=='mt5')return {status:'unresolved',reason:'unsupported_platform'}
    if(!Number.isSafeInteger(scope.issuedAtUtcMsc)||scope.issuedAtUtcMsc<2||!Number.isSafeInteger(scope.completedAtUtcMsc)
      ||scope.completedAtUtcMsc<scope.issuedAtUtcMsc)throw Error('closed_order_history_scope_invalid')
    const coverage=await this.coverage.read({route:scope.route,rangeStartUtcMsc:scope.issuedAtUtcMsc-1,rangeEndUtcMsc:scope.completedAtUtcMsc})
    if(coverage.status!=='provider_asserted')return {status:'unresolved',reason:'coverage_unavailable'}
    if(coverage.rangeStartUtcMsc>scope.issuedAtUtcMsc||coverage.rangeEndUtcMsc<scope.completedAtUtcMsc)throw Error('closed_order_history_coverage_mismatch')
    const resources=coverage.resources.filter(resource=>resource.resource==='history.deals')
    const resource=resources[0], assertion=resource?.historyCoverage
    if(resources.length!==1||!assertion||assertion.status!=='complete'||assertion.collected_at_utc_msc<scope.completedAtUtcMsc
      ||!resource?.pageMembership)return {status:'unresolved',reason:'coverage_unavailable'}
    const rows=structuredClone(await this.facts.read({accountId:scope.route.accountId,orderTicket:scope.orderTicket}))
    const fills=reconcileClosedOrderFills(scope,rows.map(row=>row.fact))
    if(!fills)return {status:'unresolved',reason:'fills_mismatch'}
    const proof=await this.sources.read({taskId:coverage.taskId,route:scope.route,dealTickets:rows.map(row=>row.fact.ticket)})
    if(proof.status!=='source_matched')return {status:'unresolved',reason:'source_missing'}
    if(proof.taskId!==coverage.taskId||proof.receiptId!==coverage.receiptId||proof.completionHash!==coverage.completionHash
      ||proof.deals.length!==rows.length||new Set(proof.deals.map(deal=>deal.ticket)).size!==rows.length)throw Error('closed_order_history_source_mismatch')
    for(const row of rows){
      const source=proof.deals.find(deal=>deal.ticket===row.fact.ticket)
      if(!source||source.dealId!==row.dealId||source.factHash!==row.fact.evidenceHash||!source.provenanceHashes.length
        ||source.provenanceHashes.some(hash=>!/^[0-9a-f]{64}$/.test(hash)))throw Error('closed_order_history_source_mismatch')
    }
    return {status:'matched',orderTicket:scope.orderTicket,positionIdentifier:scope.positionIdentifier,closedVolume:fills.closedVolume,
      lastDealAtUtcMsc:fills.lastDealAtUtcMsc,taskId:proof.taskId,receiptId:proof.receiptId,completionHash:proof.completionHash,deals:structuredClone(proof.deals)}
  }
}
