import type { BridgeGatewayRoute } from '../../bridge/index.js'
export interface ManualCandidatePageReader {
  read(taskId: string, afterRecordId: string | null, limit: number): Promise<{
    status: 'read'; route: BridgeGatewayRoute; asOfUtcMsc: number
    records: Array<{ recordId: string; revision: number }>; nextRecordId: string | null
  } | { status: 'unresolved'; reason: string }>
}
