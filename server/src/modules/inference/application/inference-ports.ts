import type { AnalysisInputSnapshot, AnalysisRun, MarketAnalysisDetail, MarketAnalysisResult, MarketAnalysisSummary, TraderDecisionDetail, TraderDecisionResult, TraderDecisionSummary, TraderInputSnapshot, TraderRun } from '../domain/inference.js'

export interface QueueAnalysisInput {
  id: string
  userId: number
  strategyId: string
  strategyVersionId: string
  symbol: string
  trigger: 'manual' | 'scheduled' | 'event'
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
}

export interface CompleteAnalysisInput {
  runId: string
  userId: number
  expectedRevision: number
  marketAnalysisId: string
  result: MarketAnalysisResult
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
}

export interface CompleteTraderInput {
  runId: string
  userId: number
  expectedRevision: number
  decisionId: string
  result: TraderDecisionResult
}

export interface InferenceRepository {
  queueAnalysis(input: QueueAnalysisInput): Promise<AnalysisRun>
  beginAnalysis(input: BeginAnalysisInput): Promise<AnalysisRun>
  completeAnalysis(input: CompleteAnalysisInput): Promise<{ analysis: MarketAnalysisSummary; traderRuns: TraderRun[] }>
  requestTraderEvaluation(input: RequestTraderEvaluationInput): Promise<TraderRun>
  beginTrader(input: BeginTraderInput): Promise<TraderRun>
  completeTrader(input: CompleteTraderInput): Promise<TraderDecisionSummary>
  getAnalysis(userId: number, analysisId: string): Promise<MarketAnalysisSummary | null>
  getAnalysisDetail(userId: number, analysisId: string): Promise<MarketAnalysisDetail | null>
  listAnalyses(userId: number, limit: number): Promise<MarketAnalysisSummary[]>
  getTraderDecision(userId: number, decisionId: string): Promise<TraderDecisionDetail | null>
  listTraderDecisions(userId: number, tradingAccountId: string, limit: number): Promise<TraderDecisionSummary[]>
}
