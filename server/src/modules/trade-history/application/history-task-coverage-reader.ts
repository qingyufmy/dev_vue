import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { HistoryResourcePageChain } from './trade-history-collector-ports.js'

export type HistoryTaskCoverageResult =
  | { status: 'unresolved'; reason: 'task_unavailable' | 'route_mismatch' | 'coverage_missing' }
  | { status: 'provider_asserted'; taskId: string; receiptId: string; completionHash: string;
      rangeStartUtcMsc: number; rangeEndUtcMsc: number; resources: HistoryResourcePageChain[] }
/** Caller authorizes the route and holds a consistent snapshot. Provider assertion is not strategy attribution. */
export interface HistoryTaskCoverageReader {
  read(scope: { taskId: string; route: BridgeGatewayRoute }): Promise<HistoryTaskCoverageResult>
}
