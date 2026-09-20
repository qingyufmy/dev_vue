import type { HistoryCollectionRequest } from './history-collection-task.js'

export interface HistoryRangeRequest extends HistoryCollectionRequest {
  userId: number
  platform: 'mt4' | 'mt5'
  ownershipIntervalId: string
}
export interface HistoryRangeRequester {
  /** Caller owns the transaction and persists taskId before external delivery. Completed still requires inventory verification. */
  ensure(input: HistoryRangeRequest, now: Date): Promise<
    | { status: 'unavailable'; reason: string }
    | { status: 'waiting'; taskId: string; reason: 'history_account_busy' | 'history_collection_pending' }
    | { status: 'completed' | 'failed'; taskId: string }
  >
}
