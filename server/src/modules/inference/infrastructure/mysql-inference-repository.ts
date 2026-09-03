import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { CompleteAnalysisInput, CompleteTraderInput, InferenceRepository, QueueAnalysisInput, RequestTraderEvaluationInput } from '../application/inference-ports.js'
import type { AnalysisRun, MarketAnalysisResult, MarketAnalysisSummary, TraderDecisionResult, TraderDecisionSummary, TraderRun } from '../domain/inference.js'
import { contentHash, InferenceError } from '../domain/inference.js'

interface AnalysisRunRow extends RowDataPacket {
  id: string; user_id: number; strategy_id: string; strategy_version_id: string; standard_symbol: string
  trigger_type: AnalysisRun['trigger']; status: AnalysisRun['status']; input_snapshot_id: string | null
  market_analysis_id: string | null; created_at_utc: Date; updated_at_utc: Date; revision: number
}
interface CooldownRow extends RowDataPacket { next_allowed_at_utc: Date }
interface MarketAnalysisRow extends RowDataPacket {
  id: string; owner_user_id: number; strategy_id: string; strategy_version_id: string; standard_symbol: string
  market_bias: MarketAnalysisSummary['marketBias']; recommendation: MarketAnalysisSummary['recommendation']; confidence: string
  summary: string; analyzed_at_utc: Date; valid_until_utc: Date; input_snapshot_hash: string; revision: number
}
interface SubscriptionRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; revision: number; trader_strategy_id: string; trader_strategy_version_id: string
}
interface TraderRunRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; subscription_id: string; subscription_revision: number
  market_analysis_id: string; strategy_id: string; strategy_version_id: string; status: TraderRun['status']
  input_snapshot_id: string | null; decision_id: string | null; created_at_utc: Date; updated_at_utc: Date; revision: number
}
interface TraderDecisionRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; market_analysis_id: string; strategy_id: string; strategy_version_id: string
  action_kind: TraderDecisionSummary['action']; side: 'buy' | 'sell' | null; confidence: string; summary: string
  status: TraderDecisionSummary['status']; input_snapshot_hash: string; created_at_utc: Date; revision: number
}
interface JsonPayloadRow extends RowDataPacket { payload_json: string | object }
interface HashRow extends RowDataPacket { content_sha256: string }

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}

const iso = (value: Date | string) => new Date(value).toISOString()
const analysisRun = (row: AnalysisRunRow): AnalysisRun => ({
  id: row.id, userId: row.user_id, strategyId: row.strategy_id, strategyVersionId: row.strategy_version_id,
  symbol: row.standard_symbol, trigger: row.trigger_type, status: row.status, inputSnapshotId: row.input_snapshot_id,
  marketAnalysisId: row.market_analysis_id, createdAt: iso(row.created_at_utc), updatedAt: iso(row.updated_at_utc), revision: Number(row.revision),
})
const marketAnalysis = (row: MarketAnalysisRow): MarketAnalysisSummary => ({
  id: row.id, userId: row.owner_user_id, strategyId: row.strategy_id, strategyVersionId: row.strategy_version_id,
  symbol: row.standard_symbol, marketBias: row.market_bias, recommendation: row.recommendation,
  confidence: Number(row.confidence), summary: row.summary, analyzedAt: iso(row.analyzed_at_utc), validUntil: iso(row.valid_until_utc),
  inputSnapshotHash: row.input_snapshot_hash, revision: Number(row.revision),
})
const traderRun = (row: TraderRunRow): TraderRun => ({
  id: row.id, userId: row.user_id, tradingAccountId: row.trading_account_id, subscriptionId: row.subscription_id,
  subscriptionRevision: Number(row.subscription_revision), marketAnalysisId: row.market_analysis_id, strategyId: row.strategy_id,
  strategyVersionId: row.strategy_version_id, status: row.status, inputSnapshotId: row.input_snapshot_id,
  decisionId: row.decision_id, createdAt: iso(row.created_at_utc), updatedAt: iso(row.updated_at_utc), revision: Number(row.revision),
})
const traderDecision = (row: TraderDecisionRow): TraderDecisionSummary => ({
  id: row.id, userId: row.user_id, tradingAccountId: row.trading_account_id, marketAnalysisId: row.market_analysis_id,
  strategyId: row.strategy_id, strategyVersionId: row.strategy_version_id, action: row.action_kind, side: row.side,
  confidence: Number(row.confidence), summary: row.summary, status: row.status, inputSnapshotHash: row.input_snapshot_hash,
  createdAt: iso(row.created_at_utc), revision: Number(row.revision),
})

const analysisRunSelect = `SELECT r.id,r.user_id,CAST(r.strategy_id AS CHAR) strategy_id,CAST(r.strategy_version_id AS CHAR) strategy_version_id,r.standard_symbol,r.trigger_type,r.status,r.input_snapshot_id,CAST(a.id AS CHAR) market_analysis_id,r.created_at_utc,r.updated_at_utc,r.revision FROM ai_analysis_runs r LEFT JOIN market_analyses a ON a.analysis_run_id=r.id`
const traderRunSelect = `SELECT r.id,r.user_id,CAST(r.trading_account_id AS CHAR) trading_account_id,CAST(r.subscription_id AS CHAR) subscription_id,r.subscription_revision,r.market_analysis_id,CAST(r.strategy_id AS CHAR) strategy_id,CAST(r.strategy_version_id AS CHAR) strategy_version_id,r.status,r.input_snapshot_id,d.id decision_id,r.created_at_utc,r.updated_at_utc,r.revision FROM ai_trader_runs r LEFT JOIN trade_decisions d ON d.trader_run_id=r.id`
const marketAnalysisSelect = `SELECT a.id,a.owner_user_id,CAST(a.strategy_id AS CHAR) strategy_id,CAST(a.strategy_version_id AS CHAR) strategy_version_id,a.standard_symbol,a.market_bias,a.recommendation,a.confidence,a.summary,a.analyzed_at_utc,a.valid_until_utc,s.payload_sha256 input_snapshot_hash,a.revision FROM market_analyses a INNER JOIN inference_snapshots s ON s.id=a.input_snapshot_id`
const traderDecisionSelect = `SELECT d.id,d.user_id,CAST(d.trading_account_id AS CHAR) trading_account_id,d.market_analysis_id,CAST(d.strategy_id AS CHAR) strategy_id,CAST(d.strategy_version_id AS CHAR) strategy_version_id,d.action_kind,d.side,d.confidence,d.summary,d.status,s.payload_sha256 input_snapshot_hash,d.created_at_utc,d.revision FROM trade_decisions d INNER JOIN inference_snapshots s ON s.id=d.input_snapshot_id`

async function outbox(connection: PoolConnection, aggregateType: string, aggregateId: string, eventType: string, payload: object) {
  await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(), aggregateType, aggregateId, eventType, JSON.stringify(payload)])
}

export class MysqlInferenceRepository implements InferenceRepository {
  constructor(private readonly pool: Pool) {}

  async queueAnalysis(input: QueueAnalysisInput) {
    return transaction(this.pool, async connection => {
      if (input.trigger === 'manual') {
        await connection.execute(`INSERT IGNORE INTO ai_manual_analysis_cooldowns (user_id,next_allowed_at_utc,updated_at_utc) VALUES (?,'1970-01-01 00:00:00.000',UTC_TIMESTAMP(3))`, [input.userId])
        const [cooldowns] = await connection.execute<CooldownRow[]>('SELECT next_allowed_at_utc FROM ai_manual_analysis_cooldowns WHERE user_id=? FOR UPDATE', [input.userId])
        const [existing] = await connection.execute<AnalysisRunRow[]>(`${analysisRunSelect} WHERE r.user_id=? AND r.idempotency_key=? LIMIT 1`, [input.userId, input.idempotencyKey])
        if (existing[0]) return analysisRun(existing[0])
        const nextAllowed = cooldowns[0]?.next_allowed_at_utc
        const requestedMs = Date.parse(input.requestedAt)
        if (nextAllowed && nextAllowed.getTime() > requestedMs) throw new InferenceError('manual_analysis_cooldown', 429, nextAllowed.getTime() - requestedMs)
        const next = new Date(requestedMs + input.manualCooldownSeconds * 1000)
        await connection.execute('UPDATE ai_manual_analysis_cooldowns SET next_allowed_at_utc=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE user_id=?', [next, input.userId])
      } else {
        const [existing] = await connection.execute<AnalysisRunRow[]>(`${analysisRunSelect} WHERE r.user_id=? AND r.idempotency_key=? LIMIT 1`, [input.userId, input.idempotencyKey])
        if (existing[0]) return analysisRun(existing[0])
      }
      await connection.execute(`INSERT INTO ai_analysis_runs (id,user_id,strategy_id,strategy_version_id,standard_symbol,trigger_type,idempotency_key,status,revision,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,'queued',1,?,?)`, [input.id, input.userId, input.strategyId, input.strategyVersionId, input.symbol, input.trigger, input.idempotencyKey, input.requestedAt, input.requestedAt])
      await outbox(connection, 'analysis', input.id, 'analysis.requested', { analysis_id: input.id })
      const [rows] = await connection.execute<AnalysisRunRow[]>(`${analysisRunSelect} WHERE r.id=?`, [input.id])
      if (!rows[0]) throw new InferenceError('analysis_persist_failed', 500)
      return analysisRun(rows[0])
    })
  }

  async beginAnalysis(input: Parameters<InferenceRepository['beginAnalysis']>[0]) {
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<AnalysisRunRow[]>(`${analysisRunSelect} WHERE r.id=? AND r.user_id=? FOR UPDATE`, [input.runId, input.userId])
      const row = rows[0]
      if (!row) throw new InferenceError('analysis_not_found', 404)
      if (Number(row.revision) !== input.expectedRevision || row.status !== 'queued') throw new InferenceError('analysis_revision_conflict', 409)
      if (input.snapshot.strategy.id !== row.strategy_id || input.snapshot.strategy.versionId !== row.strategy_version_id) throw new InferenceError('analysis_strategy_snapshot_mismatch', 409)
      const payload = JSON.stringify(input.snapshot)
      await connection.execute(`INSERT INTO inference_snapshots (id,purpose,user_id,trading_account_id,strategy_id,strategy_version_id,standard_symbol,payload_sha256,payload_bytes,captured_at_utc,created_at_utc) VALUES (?,'analysis',?,NULL,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [input.snapshotId, input.userId, row.strategy_id, row.strategy_version_id, row.standard_symbol, input.snapshotHash, Buffer.byteLength(payload), input.snapshot.capturedAt])
      await connection.execute(`INSERT INTO inference_snapshot_payloads (snapshot_id,encoding,payload_json) VALUES (?,'json',?)`, [input.snapshotId, payload])
      await connection.execute(`UPDATE ai_analysis_runs SET input_snapshot_id=?,status='running',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=?`, [input.snapshotId, input.runId])
      await outbox(connection, 'analysis', input.runId, 'analysis.running', { analysis_id: input.runId })
      const [updated] = await connection.execute<AnalysisRunRow[]>(`${analysisRunSelect} WHERE r.id=?`, [input.runId])
      return analysisRun(updated[0]!)
    })
  }

  async completeAnalysis(input: CompleteAnalysisInput) {
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<AnalysisRunRow[]>(`${analysisRunSelect} WHERE r.id=? AND r.user_id=? FOR UPDATE`, [input.runId, input.userId])
      const row = rows[0]
      if (!row) throw new InferenceError('analysis_not_found', 404)
      if (Number(row.revision) !== input.expectedRevision || row.status !== 'running' || !row.input_snapshot_id) throw new InferenceError('analysis_revision_conflict', 409)
      const payload = JSON.stringify(input.result)
      const payloadHash = contentHash(input.result)
      await connection.execute(`INSERT INTO market_analyses (id,analysis_run_id,owner_scope,owner_user_id,strategy_id,strategy_version_id,standard_symbol,market_bias,recommendation,confidence,summary,input_snapshot_id,content_sha256,analyzed_at_utc,valid_until_utc,revision,created_at_utc) VALUES (?,?,'user',?,?,?,?,?,?,?,?,?,?,?,?,1,UTC_TIMESTAMP(3))`, [input.marketAnalysisId, input.runId, input.userId, row.strategy_id, row.strategy_version_id, row.standard_symbol, input.result.marketBias, input.result.recommendation, input.result.confidence, input.result.summary, row.input_snapshot_id, payloadHash, input.result.analyzedAt, input.result.validUntil])
      await connection.execute('INSERT INTO market_analysis_payloads (market_analysis_id,payload_json,payload_sha256,payload_bytes) VALUES (?,?,?,?)', [input.marketAnalysisId, payload, payloadHash, Buffer.byteLength(payload)])
      await connection.execute(`UPDATE ai_analysis_runs SET status='succeeded',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3),completed_at_utc=UTC_TIMESTAMP(3) WHERE id=?`, [input.runId])
      const createdTraderRuns: TraderRun[] = []
      if (row.trigger_type !== 'manual') {
        const [subscriptions] = await connection.execute<SubscriptionRow[]>(`SELECT CAST(id AS CHAR) id,user_id,CAST(trading_account_id AS CHAR) trading_account_id,revision,CAST(trader_strategy_id AS CHAR) trader_strategy_id,CAST(trader_strategy_version_id AS CHAR) trader_strategy_version_id FROM strategy_subscriptions WHERE user_id=? AND analysis_strategy_version_id=? AND standard_symbol=? AND status='active' AND analysis_enabled=1 AND trader_enabled=1 AND trader_strategy_id IS NOT NULL AND trader_strategy_version_id IS NOT NULL ORDER BY trading_account_id,id FOR SHARE`, [input.userId, row.strategy_version_id, row.standard_symbol])
        for (const subscription of subscriptions) {
          const id = randomUUID()
          const idempotencyKey = `analysis:${input.marketAnalysisId}:subscription:${subscription.id}:revision:${subscription.revision}`
          await connection.execute(`INSERT INTO ai_trader_runs (id,user_id,trading_account_id,subscription_id,subscription_revision,market_analysis_id,strategy_id,strategy_version_id,idempotency_key,status,revision,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,'queued',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [id, subscription.user_id, subscription.trading_account_id, subscription.id, subscription.revision, input.marketAnalysisId, subscription.trader_strategy_id, subscription.trader_strategy_version_id, idempotencyKey])
          await outbox(connection, 'trader', id, 'trader.requested', { trader_run_id: id, market_analysis_id: input.marketAnalysisId, trading_account_id: subscription.trading_account_id })
          const [created] = await connection.execute<TraderRunRow[]>(`${traderRunSelect} WHERE r.id=?`, [id])
          if (created[0]) createdTraderRuns.push(traderRun(created[0]))
        }
      }
      await outbox(connection, 'market_analysis', input.marketAnalysisId, 'market_analysis.created', { market_analysis_id: input.marketAnalysisId })
      const [analysisRows] = await connection.execute<MarketAnalysisRow[]>(`${marketAnalysisSelect} WHERE a.id=?`, [input.marketAnalysisId])
      return { analysis: marketAnalysis(analysisRows[0]!), traderRuns: createdTraderRuns }
    })
  }

  async requestTraderEvaluation(input: RequestTraderEvaluationInput) {
    return transaction(this.pool, async connection => {
      const [existing] = await connection.execute<TraderRunRow[]>(`${traderRunSelect} WHERE r.user_id=? AND r.idempotency_key=? LIMIT 1`, [input.userId, input.idempotencyKey])
      if (existing[0]) return traderRun(existing[0])
      const [analyses] = await connection.execute<RowDataPacket[]>(`SELECT id FROM market_analyses WHERE id=? AND owner_user_id=? AND valid_until_utc>? LIMIT 1 FOR SHARE`, [input.marketAnalysisId, input.userId, input.requestedAt])
      if (!analyses[0]) throw new InferenceError('analysis_expired_or_forbidden', 409)
      const [subscriptions] = await connection.execute<RowDataPacket[]>(`SELECT id FROM strategy_subscriptions WHERE id=? AND user_id=? AND trading_account_id=? AND revision=? AND trader_strategy_id=? AND trader_strategy_version_id=? AND status='active' AND trader_enabled=1 LIMIT 1 FOR UPDATE`, [input.subscriptionId, input.userId, input.tradingAccountId, input.subscriptionRevision, input.strategyId, input.strategyVersionId])
      if (!subscriptions[0]) throw new InferenceError('subscription_revision_conflict', 409)
      const [concurrent] = await connection.execute<TraderRunRow[]>(`${traderRunSelect} WHERE r.user_id=? AND r.idempotency_key=? LIMIT 1`, [input.userId, input.idempotencyKey])
      if (concurrent[0]) return traderRun(concurrent[0])
      await connection.execute(`INSERT INTO ai_trader_runs (id,user_id,trading_account_id,subscription_id,subscription_revision,market_analysis_id,strategy_id,strategy_version_id,idempotency_key,status,revision,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,'queued',1,?,?)`, [input.id, input.userId, input.tradingAccountId, input.subscriptionId, input.subscriptionRevision, input.marketAnalysisId, input.strategyId, input.strategyVersionId, input.idempotencyKey, input.requestedAt, input.requestedAt])
      await outbox(connection, 'trader', input.id, 'trader.requested', { trader_run_id: input.id, market_analysis_id: input.marketAnalysisId, trading_account_id: input.tradingAccountId })
      const [created] = await connection.execute<TraderRunRow[]>(`${traderRunSelect} WHERE r.id=?`, [input.id])
      return traderRun(created[0]!)
    })
  }

  async beginTrader(input: Parameters<InferenceRepository['beginTrader']>[0]) {
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<TraderRunRow[]>(`${traderRunSelect} WHERE r.id=? AND r.user_id=? FOR UPDATE`, [input.runId, input.userId])
      const row = rows[0]
      if (!row) throw new InferenceError('trader_run_not_found', 404)
      if (Number(row.revision) !== input.expectedRevision || row.status !== 'queued') throw new InferenceError('trader_revision_conflict', 409)
      if (String(input.snapshot.account.id) !== row.trading_account_id) throw new InferenceError('trader_account_snapshot_mismatch', 409)
      if (input.snapshot.strategy.id !== row.strategy_id || input.snapshot.strategy.versionId !== row.strategy_version_id) throw new InferenceError('trader_strategy_snapshot_mismatch', 409)
      if (input.snapshot.subscriptionRevision !== Number(row.subscription_revision) || input.snapshot.analysis.id !== row.market_analysis_id) throw new InferenceError('trader_context_snapshot_mismatch', 409)
      const [analysisRows] = await connection.execute<HashRow[]>('SELECT content_sha256 FROM market_analyses WHERE id=? FOR SHARE', [row.market_analysis_id])
      if (analysisRows[0]?.content_sha256 !== input.snapshot.analysis.contentHash) throw new InferenceError('trader_analysis_hash_mismatch', 409)
      const payload = JSON.stringify(input.snapshot)
      await connection.execute(`INSERT INTO inference_snapshots (id,purpose,user_id,trading_account_id,strategy_id,strategy_version_id,standard_symbol,payload_sha256,payload_bytes,captured_at_utc,created_at_utc) SELECT ?,'trader',r.user_id,r.trading_account_id,r.strategy_id,r.strategy_version_id,a.standard_symbol,?,?,?,UTC_TIMESTAMP(3) FROM ai_trader_runs r INNER JOIN market_analyses a ON a.id=r.market_analysis_id WHERE r.id=?`, [input.snapshotId, input.snapshotHash, Buffer.byteLength(payload), input.snapshot.capturedAt, input.runId])
      await connection.execute(`INSERT INTO inference_snapshot_payloads (snapshot_id,encoding,payload_json) VALUES (?,'json',?)`, [input.snapshotId, payload])
      await connection.execute(`UPDATE ai_trader_runs SET input_snapshot_id=?,status='running',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=?`, [input.snapshotId, input.runId])
      await outbox(connection, 'trader', input.runId, 'trader.running', { trader_run_id: input.runId })
      const [updated] = await connection.execute<TraderRunRow[]>(`${traderRunSelect} WHERE r.id=?`, [input.runId])
      return traderRun(updated[0]!)
    })
  }

  async completeTrader(input: CompleteTraderInput) {
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<TraderRunRow[]>(`${traderRunSelect} WHERE r.id=? AND r.user_id=? FOR UPDATE`, [input.runId, input.userId])
      const row = rows[0]
      if (!row) throw new InferenceError('trader_run_not_found', 404)
      if (Number(row.revision) !== input.expectedRevision || row.status !== 'running' || !row.input_snapshot_id) throw new InferenceError('trader_revision_conflict', 409)
      const payload = JSON.stringify(input.result)
      const payloadHash = contentHash(input.result)
      await connection.execute(`INSERT INTO trade_decisions (id,trader_run_id,user_id,trading_account_id,market_analysis_id,strategy_id,strategy_version_id,action_kind,side,confidence,summary,input_snapshot_id,content_sha256,status,revision,created_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',1,UTC_TIMESTAMP(3))`, [input.decisionId, input.runId, input.userId, row.trading_account_id, row.market_analysis_id, row.strategy_id, row.strategy_version_id, input.result.action, input.result.side, input.result.confidence, input.result.summary, row.input_snapshot_id, payloadHash])
      await connection.execute('INSERT INTO trade_decision_payloads (trade_decision_id,payload_json,payload_sha256,payload_bytes) VALUES (?,?,?,?)', [input.decisionId, payload, payloadHash, Buffer.byteLength(payload)])
      await connection.execute(`UPDATE ai_trader_runs SET status='succeeded',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3),completed_at_utc=UTC_TIMESTAMP(3) WHERE id=?`, [input.runId])
      await outbox(connection, 'trade_decision', input.decisionId, 'trade_decision.created', { decision_id: input.decisionId, market_analysis_id: row.market_analysis_id, trading_account_id: row.trading_account_id })
      const [decisions] = await connection.execute<TraderDecisionRow[]>(`${traderDecisionSelect} WHERE d.id=?`, [input.decisionId])
      return traderDecision(decisions[0]!)
    })
  }

  async getAnalysis(userId: number, analysisId: string) { const [rows] = await this.pool.execute<MarketAnalysisRow[]>(`${marketAnalysisSelect} WHERE a.id=? AND a.owner_user_id=? LIMIT 1`, [analysisId, userId]); return rows[0] ? marketAnalysis(rows[0]) : null }
  async getAnalysisDetail(userId: number, analysisId: string) {
    const summary = await this.getAnalysis(userId, analysisId)
    if (!summary) return null
    const [rows] = await this.pool.execute<JsonPayloadRow[]>('SELECT p.payload_json FROM market_analysis_payloads p INNER JOIN market_analyses a ON a.id=p.market_analysis_id WHERE p.market_analysis_id=? AND a.owner_user_id=? LIMIT 1', [analysisId, userId])
    const payload = rows[0]?.payload_json
    if (!payload) throw new InferenceError('analysis_payload_missing', 500)
    return { summary, result: parsePayload<MarketAnalysisResult>(payload) }
  }
  async listAnalyses(userId: number, limit: number) { const [rows] = await this.pool.execute<MarketAnalysisRow[]>(`${marketAnalysisSelect} WHERE a.owner_user_id=? ORDER BY a.created_at_utc DESC,a.id DESC LIMIT ?`, [userId, limit]); return rows.map(marketAnalysis) }
  async getTraderDecision(userId: number, decisionId: string) {
    const [rows] = await this.pool.execute<TraderDecisionRow[]>(`${traderDecisionSelect} WHERE d.id=? AND d.user_id=? LIMIT 1`, [decisionId, userId])
    if (!rows[0]) return null
    const [payloadRows] = await this.pool.execute<JsonPayloadRow[]>('SELECT payload_json FROM trade_decision_payloads WHERE trade_decision_id=? LIMIT 1', [decisionId])
    const payload = payloadRows[0]?.payload_json
    if (!payload) throw new InferenceError('trade_decision_payload_missing', 500)
    return { summary: traderDecision(rows[0]), result: parsePayload<TraderDecisionResult>(payload) }
  }
  async listTraderDecisions(userId: number, tradingAccountId: string, limit: number) { const [rows] = await this.pool.execute<TraderDecisionRow[]>(`${traderDecisionSelect} WHERE d.user_id=? AND d.trading_account_id=? ORDER BY d.created_at_utc DESC,d.id DESC LIMIT ?`, [userId, tradingAccountId, limit]); return rows.map(traderDecision) }
}

function parsePayload<T>(value: string | object): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T }
