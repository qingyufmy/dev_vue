import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq'

export const EXECUTION_QUEUE = 'aurum-v4-execution'
export const BRIDGE_DISPATCH_QUEUE = 'aurum-v4-bridge-dispatch'
export const ANALYSIS_QUEUE = 'aurum-v4-analysis'
export const TRADER_QUEUE = 'aurum-v4-trader'
export const RISK_QUEUE = 'aurum-v4-risk'
export const MANUAL_CANDIDATE_QUEUE = 'aurum-v4-manual-candidates'
export const SYSTEM_REVIEW_QUEUE = 'aurum-v4-system-reviews'
export const PERIOD_REVIEW_QUEUE = 'aurum-v4-period-reviews'
export const REVIEW_QUEUE = 'aurum-v4-review'
export const BRIDGE_HISTORY_TASK_QUEUE = 'aurum-v4-bridge-history-task'
export const BRIDGE_INSTRUMENT_QUEUE = 'aurum-v4-bridge-instrument'

export interface ExecutionIntentJob { intentId: string }
export interface ApprovedRiskDecisionJob { riskDecisionId: string; userId: number }
export interface ExecutionDistributionTargetJob { distributionTargetId: string }
export interface BridgeCommandJob { commandId: string }
export interface AnalysisRunJob { analysisId: string }
export interface TraderRunJob { traderRunId: string }
export interface RiskReviewJob { decisionId: string }
export interface ReviewRunJob { reviewJobId: string }
export interface BridgeHistoryTaskJob { taskId: string }
export interface BridgeInstrumentJob { requestId: string }
export type ExecutionJob = ExecutionIntentJob | ApprovedRiskDecisionJob | ExecutionDistributionTargetJob

const jobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 2_000 },
  removeOnFail: { count: 5_000 },
}

export class RuntimeTaskQueues {
  readonly execution: Queue<ExecutionJob>
  readonly bridgeDispatch: Queue<BridgeCommandJob>
  readonly analysis: Queue<AnalysisRunJob>
  readonly trader: Queue<TraderRunJob>
  readonly risk: Queue<RiskReviewJob>
  readonly review: Queue<ReviewRunJob>
  readonly manualCandidates: Queue<BridgeHistoryTaskJob>
  readonly bridgeHistoryTask: Queue<BridgeHistoryTaskJob>
  readonly bridgeInstrument: Queue<BridgeInstrumentJob>

  constructor(connection: ConnectionOptions, prefix: string) {
    this.execution = new Queue(EXECUTION_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
    this.bridgeDispatch = new Queue(BRIDGE_DISPATCH_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
    this.analysis = new Queue(ANALYSIS_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
    this.trader = new Queue(TRADER_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
    this.risk = new Queue(RISK_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
    this.manualCandidates = new Queue(MANUAL_CANDIDATE_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
    this.review = new Queue(REVIEW_QUEUE, { connection, prefix, defaultJobOptions: { ...jobOptions, priority: 20 } })
    this.bridgeHistoryTask = new Queue(BRIDGE_HISTORY_TASK_QUEUE, { connection, prefix, defaultJobOptions: { ...jobOptions, priority: 30 } })
    this.bridgeInstrument = new Queue(BRIDGE_INSTRUMENT_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
  }

  async close() {
    await Promise.all([
      this.execution.close(), this.bridgeDispatch.close(), this.analysis.close(), this.trader.close(), this.risk.close(), this.review.close(), this.manualCandidates.close(), this.bridgeHistoryTask.close(),
      this.bridgeInstrument.close(),
    ])
  }
}
