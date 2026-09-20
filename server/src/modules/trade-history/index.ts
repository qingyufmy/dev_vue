export * from './domain/trade-history.js'
export * from './domain/trade-history-attribution.js'
export * from './domain/terminal-history-projection.js'
export { reconcileOpenPositionLifecycle, type OpenPositionLifecycleInput, type OpenPositionLifecycleResult } from './domain/open-position-lifecycle.js'
export type { OpenPositionLifecycleReader, OpenPositionLifecycleScope } from './application/open-position-lifecycle-reader.js'
export * from './application/trade-history-ports.js'
export * from './application/trade-history-service.js'
export * from './application/trade-history-collector-ports.js'
export * from './application/trade-history-collector.js'
export * from './application/trade-history-scheduler.js'
export { HistoryTaskProcessor } from './application/history-task-processor.js'
export { HistoryTaskWorker, type HistoryTaskLocator } from './application/history-task-worker.js'
export type { HistoryCollectionTasks, HistoryCollectionTaskClaimResult } from './application/history-collection-tasks.js'
export type { HistoryCollectionClaim } from './application/history-collection-task.js'

export type { HistoryTraversalReader, HistoryTraversalScope, HistoryTraversalResult } from './application/history-traversal-reader.js'

export type { HistoryTaskCoverageReader, HistoryTaskCoverageResult } from './application/history-task-coverage-reader.js'

export type { HistoryTaskDealSourceReader, HistoryTaskDealSourceResult } from './application/history-task-deal-source-reader.js'

export type { HistoryWindowCoverageReader } from './application/history-window-coverage-reader.js'

export type { OpenPositionHistoryReader, OpenPositionHistoryScope, OpenPositionHistoryResult } from './application/open-position-history-reader.js'

export type { ClosedOrderHistoryReader, ClosedOrderHistoryScope, ClosedOrderHistoryResult } from './application/closed-order-history-reader.js'
export { readTradeCostEvidence, type TradeCostEvidence, type TradeCostField } from './domain/trade-cost-evidence.js'
export type { ReviewTradeEvidenceReader, ReviewTradeEvidenceResult, ReviewTradeEvidence } from './application/review-trade-evidence-reader.js'
export type { HistoryTaskDealInventoryReader, HistoryTaskDealInventoryResult } from './application/history-task-deal-inventory-reader.js'
export { createReviewTradeReadinessReader, type ReviewTradeReadiness, type ReviewTradeReadinessReader } from './application/review-trade-readiness.js'
export type { ManualCandidatePageReader } from './application/manual-candidate-page-reader.js'

export { resolveSystemTradeSource } from './application/system-trade-source.js'
export type { SystemDealProof, SystemTradeSource } from './application/system-trade-source.js'
export type { HistoryRangeRequest, HistoryRangeRequester } from './application/history-range-requester.js'
export type { HistoryTaskDealInventoryPageReader, HistoryTaskDealInventoryPage } from './application/history-task-deal-inventory-reader.js'

export type { ArchivedExecutionDeal, ArchivedDealPage } from './application/archived-execution-deals.js'
