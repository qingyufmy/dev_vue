import type { AnalysisInputSnapshot, AnalysisRun, AnalysisWorkClaim, JsonObject, MarketAnalysisDetail, MarketAnalysisResult, MarketAnalysisSummary, TraderDecisionDetail, TraderDecisionResult, TraderDecisionSummary, TraderInputSnapshot, TraderRun, TraderWorkClaim } from '../domain/inference.js'

export interface QueueAnalysisInput {
  id: string
  userId: number
  strategyId: string
  strategyVersionId: string
  symbol: string
  trigger: 'manual' | 'scheduled' | 'event'
  scheduleSlot: string | null
  marketSourceAccountId: string | null
  idempotencyKey: string
  requestedAt: string
  manualCooldownSeconds: number
}

export interface BeginAnalysisInput {
  runId: string
  userId: number
  expectedRevision: number
  snapshotId: string
  snapshot: AnalysisInputSnapshot
  snapshotHash: string
  taskId: string
  attemptId: string
  modelProfileId: string | null
  provider: string
  model: string
  workerId: string
  deadlineAt: string
}

export interface CompleteAnalysisInput {
  runId: string
  userId: number
  expectedRevision: number
  marketAnalysisId: string
  taskId: string
  attemptId: string
  fencingToken: number
  usage: JsonObject | null
  result: MarketAnalysisResult
}

export interface FailAnalysisAttemptInput {
  runId: string
  userId: number
  expectedRevision: number
  taskId: string
  attemptId: string
  attemptNumber: number
  fencingToken: number
  provider: string
  model: string
  errorCode: string
  failureStatus: 'failed' | 'timed_out' | 'contract_invalid'
  retryable: boolean
  maxAttempts: number
}

export interface RequestTraderEvaluationInput {
  id: string
  userId: number
  tradingAccountId: string
  marketAnalysisId: string
  subscriptionId: string
  subscriptionRevision: number
  strategyId: string
  strategyVersionId: string
  idempotencyKey: string
  requestedAt: string
}

export interface BeginTraderInput {
  runId: string
  userId: number
  expectedRevision: number
  snapshotId: string
  snapshot: TraderInputSnapshot
  snapshotHash: string
  taskId: string
  attemptId: string
  modelProfileId: string | null
  provider: string
  model: string
  workerId: string
  deadlineAt: string
}

export interface CompleteTraderInput {
  runId: string
  userId: number
  expectedRevision: number
  decisionId: string
  taskId: string
  attemptId: string
  fencingToken: number
  usage: JsonObject | null
  result: TraderDecisionResult
}

export interface FailTraderAttemptInput extends FailAnalysisAttemptInput {}

export interface InferenceRepository {
  queueAnalysis(input: QueueAnalysisInput): Promise<AnalysisRun>
  getAnalysisRun(runId: string): Promise<AnalysisRun | null>
  getTraderRun(runId: string): Promise<TraderRun | null>
  beginAnalysis(input: BeginAnalysisInput): Promise<AnalysisWorkClaim>
  completeAnalysis(input: CompleteAnalysisInput): Promise<{ analysis: MarketAnalysisSummary; traderRuns: TraderRun[] }>
  failAnalysisAttempt(input: FailAnalysisAttemptInput): Promise<AnalysisWorkClaim | null>
  failQueuedAnalysis(runId: string, errorCode: string): Promise<void>
  requestTraderEvaluation(input: RequestTraderEvaluationInput): Promise<TraderRun>
  beginTrader(input: BeginTraderInput): Promise<TraderWorkClaim>
  completeTrader(input: CompleteTraderInput): Promise<TraderDecisionSummary>
  failTraderAttempt(input: FailTraderAttemptInput): Promise<TraderWorkClaim | null>
  failQueuedTrader(runId: string, errorCode: string): Promise<void>
  getAnalysis(userId: number, analysisId: string): Promise<MarketAnalysisSummary | null>
  getAnalysisDetail(userId: number, analysisId: string): Promise<MarketAnalysisDetail | null>
  listAnalyses(userId: number, limit: number): Promise<MarketAnalysisSummary[]>
  getTraderDecision(userId: number, decisionId: string): Promise<TraderDecisionDetail | null>
  listTraderDecisions(userId: number, tradingAccountId: string, limit: number): Promise<TraderDecisionSummary[]>
}
