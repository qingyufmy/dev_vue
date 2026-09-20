import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { contentHash, type JsonObject, type TraderInputSnapshot } from '../domain/inference.js'
import { createMysqlTradeDecisionOriginReader } from './mysql-trade-decision-origin-reader.js'

/** Historical, immutable model input and output; never joins current subscription configuration. */
export function createMysqlReviewDecisionContext(connection: Pick<PoolConnection, 'execute'>) {
  const origins = createMysqlTradeDecisionOriginReader(connection)
  return { async read(input: Parameters<typeof origins.read>[0]) {
    input = structuredClone(input)
    const origin = await origins.read(input)
    if (!origin) return null
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT d.content_sha256 decision_hash,p.payload_sha256,p.payload_json,
      s.payload_sha256 snapshot_hash,sp.payload_json snapshot_json,CAST(r.subscription_id AS CHAR) subscription_id,
      CAST(r.subscription_revision AS CHAR) subscription_revision,r.market_analysis_id,s.id snapshot_id,
      a.content_sha256 analysis_hash
      FROM trade_decisions d INNER JOIN trade_decision_payloads p ON p.trade_decision_id=d.id
      INNER JOIN ai_trader_runs r ON r.id=d.trader_run_id AND r.user_id=d.user_id
        AND r.trading_account_id=d.trading_account_id AND r.input_snapshot_id=d.input_snapshot_id
      INNER JOIN inference_snapshots s ON s.id=d.input_snapshot_id AND s.user_id=d.user_id
        AND s.trading_account_id=d.trading_account_id AND s.strategy_id=d.strategy_id
        AND s.strategy_version_id=d.strategy_version_id AND s.purpose='trader'
      INNER JOIN inference_snapshot_payloads sp ON sp.snapshot_id=s.id AND sp.encoding='json'
      INNER JOIN market_analyses a ON a.id=d.market_analysis_id
      WHERE d.id=? AND d.risk_decision_id=? AND d.user_id=? AND d.trading_account_id=? LIMIT 2 FOR SHARE`,
    [input.decisionId,input.riskDecisionId,input.userId,input.accountId])
    if (rows.length !== 1) return null
    const row = rows[0]!
    const parse = (value: unknown): JsonObject => {
      let result: unknown
      try { result = typeof value === 'string' ? JSON.parse(value) : value } catch { throw Error('review_decision_context_corrupt') }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('review_decision_context_corrupt')
      return result as JsonObject
    }
    const decision = parse(row.payload_json), snapshot = parse(row.snapshot_json) as unknown as TraderInputSnapshot
    if (contentHash(decision) !== row.decision_hash || row.payload_sha256 !== row.decision_hash
      || contentHash(snapshot) !== row.snapshot_hash || snapshot.kind !== 'trader'
      || snapshot.strategy?.id !== origin.strategyId || snapshot.strategy?.versionId !== origin.strategyVersionId
      || String(snapshot.account?.id) !== origin.accountId || snapshot.analysis?.id !== row.market_analysis_id
      || snapshot.analysis?.contentHash !== row.analysis_hash || contentHash(snapshot.analysis.result) !== row.analysis_hash
      || !Number.isSafeInteger(snapshot.subscriptionRevision) || snapshot.subscriptionRevision < 1
      || String(snapshot.subscriptionRevision) !== row.subscription_revision) throw Error('review_decision_context_corrupt')
    return { ...origin, snapshotId: String(row.snapshot_id), snapshotHash: String(row.snapshot_hash),
      decisionHash: String(row.decision_hash), decision, snapshot,
      subscriptionId: String(row.subscription_id), subscriptionRevision: String(row.subscription_revision) }
  } }
}
