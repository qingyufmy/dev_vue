import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { OpenPositionLifecycleReader, OpenPositionLifecycleScope } from './open-position-lifecycle-reader.js'
import type { HistoryWindowCoverageReader } from './history-window-coverage-reader.js'
import type { HistoryTaskDealSourceReader, HistoryTaskDealSourceResult } from './history-task-deal-source-reader.js'
import type { OpenPositionLifecycleResult } from '../domain/open-position-lifecycle.js'

export type OpenPositionHistoryScope = Omit<OpenPositionLifecycleScope,'accountId'> & { route: BridgeGatewayRoute }
export type OpenPositionHistoryResult =
  | { status:'unresolved'; reason:'unsupported_platform'|'lifecycle_unresolved'|'coverage_unavailable'|'source_missing' }
  | { status:'source_matched'; lifecycle:Extract<OpenPositionLifecycleResult,{status:'matches_snapshot'}>;
      taskId:string; receiptId:string; completionHash:string; deals:Extract<HistoryTaskDealSourceResult,{status:'source_matched'}>['deals'] }
export interface OpenPositionHistoryReader { read(scope:OpenPositionHistoryScope):Promise<OpenPositionHistoryResult> }
export interface PositionHistoryStartReader { read(scope:OpenPositionLifecycleScope):Promise<number|null> }

/** All ports must share the caller's authorized consistent snapshot. Verifies task page membership through sources; does not prove strategy ownership. */
export class ReadOpenPositionHistory implements OpenPositionHistoryReader {
  constructor(private readonly lifecycle:OpenPositionLifecycleReader, private readonly start:PositionHistoryStartReader,
    private readonly coverage:HistoryWindowCoverageReader, private readonly sources:HistoryTaskDealSourceReader) {}
  async read(input:OpenPositionHistoryScope):Promise<OpenPositionHistoryResult> {
    const scope=structuredClone(input)
    if(scope.route.platform!=='mt5') return {status:'unresolved',reason:'unsupported_platform'}
    const position={accountId:scope.route.accountId,positionIdentifier:scope.positionIdentifier,symbol:scope.symbol,side:scope.side,volume:scope.volume,observedAtUtcMsc:scope.observedAtUtcMsc}
    const lifecycle=structuredClone(await this.lifecycle.read(position))
    if(lifecycle.status!=='matches_snapshot') return {status:'unresolved',reason:'lifecycle_unresolved'}
    if(lifecycle.positionIdentifier!==scope.positionIdentifier || lifecycle.side!==scope.side || lifecycle.volume!==scope.volume
      || !Array.isArray(lifecycle.dealTickets) || lifecycle.dealTickets.length===0 || lifecycle.dealTickets.length>10000
      || new Set(lifecycle.dealTickets).size!==lifecycle.dealTickets.length) throw Error('position_history_lifecycle_mismatch')
    const earliest=await this.start.read(position)
    if(earliest===null || !Number.isSafeInteger(earliest) || earliest<1 || earliest>scope.observedAtUtcMsc) throw Error('position_history_window_invalid')
    const coverage=await this.coverage.read({route:scope.route,rangeStartUtcMsc:Math.max(1,Math.min(earliest,scope.observedAtUtcMsc-1)),rangeEndUtcMsc:scope.observedAtUtcMsc})
    if(coverage.status!=='provider_asserted') return {status:'unresolved',reason:'coverage_unavailable'}
    const deals:Extract<HistoryTaskDealSourceResult,{status:'source_matched'}>['deals']=[]
    for(let offset=0;offset<lifecycle.dealTickets.length;offset+=1000) {
      const tickets=lifecycle.dealTickets.slice(offset,offset+1000)
      const evidence=await this.sources.read({taskId:coverage.taskId,route:scope.route,dealTickets:tickets})
      if(evidence.status!=='source_matched') return {status:'unresolved',reason:'source_missing'}
      if(evidence.taskId!==coverage.taskId || evidence.receiptId!==coverage.receiptId || evidence.completionHash!==coverage.completionHash
        || evidence.deals.length!==tickets.length || new Set(evidence.deals.map(d=>d.ticket)).size!==tickets.length
        || evidence.deals.some(d=>!tickets.includes(d.ticket))) throw Error('position_history_source_mismatch')
      deals.push(...structuredClone(evidence.deals))
    }
    return {status:'source_matched',lifecycle,taskId:coverage.taskId,receiptId:coverage.receiptId,completionHash:coverage.completionHash,deals}
  }
}
