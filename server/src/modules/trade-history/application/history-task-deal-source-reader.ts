import type { BridgeGatewayRoute } from '../../bridge/index.js'
export type HistoryTaskDealSourceResult =
  | { status: 'unresolved'; reason: 'coverage_unavailable' | 'source_missing' | 'unsupported_platform' }
  | { status: 'source_matched'; taskId: string; receiptId: string; completionHash: string;
      deals: Array<{ ticket: string; dealId: string; factHash: string; provenanceHashes: string[] }> }
/** Caller owns authorization and the consistent snapshot. Requires completed-task page membership and matching persisted response provenance. */
export interface HistoryTaskDealSourceReader {
  read(scope: { taskId: string; route: BridgeGatewayRoute; dealTickets: readonly string[] }): Promise<HistoryTaskDealSourceResult>
}
