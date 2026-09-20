import type { BridgeGatewayRoute } from '../../bridge/index.js'
export type HistoryTaskDealInventoryResult =
  | { status: 'unresolved'; reason: 'unsupported_platform' | 'coverage_unavailable' | 'inventory_missing' | 'inventory_limit' }
  | { status: 'inventory_matched'; taskId: string; receiptId: string; completionHash: string; rangeStartUtcMsc: number; rangeEndUtcMsc: number;
      facts: Array<{ id: string; ticket: string; hash: string; raw: Record<string, unknown>; provenanceHashes: string[] }> }
/** Validates every fact in the completed task, not just tickets already linked to a projected trade. */
export interface HistoryTaskDealInventoryReader {
  read(input: { taskId: string; route: BridgeGatewayRoute }): Promise<HistoryTaskDealInventoryResult>
}

export type HistoryTaskDealInventoryPage = Exclude<HistoryTaskDealInventoryResult,{status:'inventory_matched'}> | {
  status:'inventory_page';taskId:string;receiptId:string;completionHash:string;rangeStartUtcMsc:number;rangeEndUtcMsc:number;
  facts:Extract<HistoryTaskDealInventoryResult,{status:'inventory_matched'}>['facts'];nextHash:string|null
}
export interface HistoryTaskDealInventoryPageReader {
  read(input:{taskId:string;route:BridgeGatewayRoute;afterHash:string|null;completionHash:string|null;limit:number}):Promise<HistoryTaskDealInventoryPage>
}
