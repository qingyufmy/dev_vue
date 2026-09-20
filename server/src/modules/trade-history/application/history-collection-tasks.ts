import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { HistoryCollectionClaim } from './history-collection-task.js'
import type { historyTaskCompletion } from './history-task-completion.js'

export type HistoryCollectionTaskClaimResult =
  | { state: 'terminal'; status: 'succeeded' | 'failed' }
  | { state: 'busy'; retryAt: string }
  | { state: 'collecting'; claim: HistoryCollectionClaim }
  | { state: 'completing'; claim: HistoryCollectionClaim; completion: ReturnType<typeof historyTaskCompletion> }

export interface HistoryCollectionTasks {
  claim(taskId: string, route: BridgeGatewayRoute): Promise<HistoryCollectionTaskClaimResult>
  renew(claim: HistoryCollectionClaim, route: BridgeGatewayRoute): Promise<void>
}
