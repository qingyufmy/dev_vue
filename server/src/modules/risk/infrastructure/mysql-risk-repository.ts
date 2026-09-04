import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { TraderDecisionResult } from '../../inference/domain/inference.js'
import { assessManualRelease, manualReleaseStillValid, type ManualRiskRelease, type ManualReleaseRuleCode } from '../domain/manual-risk-release.js'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy, riskPolicyHash, RiskError, type AccountRiskPolicyPatch, type AccountRiskSummary, type EffectiveRiskPolicy, type RiskEvaluationInput, type RiskEvaluationResult, type RiskInstrumentSnapshot } from '../domain/risk.js'
import type { CompleteRiskReviewInput, CreateManualRiskReleaseInput, ReplaceAccountRiskPolicyInput, RiskDecisionDetail, RiskDecisionSummary, RiskRepository, SaveRiskSummaryInput } from '../application/risk-ports.js'

interface PolicyRow extends RowDataPacket {
  set_id: string; scope: 'platform' | 'account'; owner_user_id: number | null; trading_account_id: string | null
  set_revision: number; version_id: string; policy_json: string | object; updated_at_utc: Date
}
interface ControlRow extends RowDataPacket { kill_switch: number; revision: number }
interface PayloadRow extends RowDataPacket { payload_json: string | object }
interface DecisionCandidateRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; decision_revision: number; decision_status: string
  decision_created_at: Date; decision_payload: string | object; standard_symbol: string
  analysis_revision: number; subscription_revision: number; account_revision: number; positions_revision: number
  pending_orders_revision: number; quote_revision: number; contract_revision: number; risk_revision: number
  ownership_active: number; subscription_active: number; subscription_trade_send_enabled: number; account_trade_permission: number
}
interface QuoteRow extends RowDataPacket { symbol: string; bid: string; ask: string; observed_at_utc: Date; revision: number }
interface InstrumentRow extends RowDataPacket { symbol: string; payload_json: string | object; revision: number }
interface RevisionRow extends RowDataPacket { revision: number }
interface RiskDecisionRow extends RowDataPacket {
  id: string; trade_decision_id: string; user_id: number; trading_account_id: string
  decision_status: RiskDecisionSummary['status']; reject_code: string | null
  platform_policy_version_id: string; account_policy_version_id: string | null
  account_risk_revision: number; created_at_utc: Date; revision: number
  manual_release_id: string | null
}
interface RiskDecisionDetailRow extends RiskDecisionRow { evaluation_json: string | object }
interface ManualReleaseRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; status: ManualRiskRelease['status']
  platform_policy_version_id: string; account_policy_version_id: string | null; policy_set_revision: number
  released_rules_json: string | object; baseline_json: string | object; risk_state_revision: number
  breach_fingerprint: string; reason: string; expires_at_utc: Date; created_at_utc: Date
  invalidated_at_utc: Date | null; invalidation_reason: string | null; revision: number; request_sha256: string
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const value = await work(connection); await connection.commit(); return value }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}

export class MysqlRiskRepository implements RiskRepository {
  constructor(private readonly pool: Pool) {}

  async getEffectivePolicy(userId: number, accountId: string) {
    const [owned] = await this.pool.execute<RowDataPacket[]>(`SELECT 1 FROM trading_account_ownerships WHERE user_id=? AND trading_account_id=? AND role='owner' AND revoked_at_utc IS NULL LIMIT 1`, [userId, accountId])
    if (!owned[0]) return null
    const [platformRows] = await this.pool.execute<PolicyRow[]>(policySelect("p.scope='platform'"))
    const platform = platformRows[0]
    if (!platform) throw new RiskError('risk_platform_policy_missing', 409)
    const [accountRows] = await this.pool.execute<PolicyRow[]>(policySelect("p.scope='account' AND p.owner_user_id=? AND p.trading_account_id=?"), [userId, accountId])
    const [controls] = await this.pool.execute<ControlRow[]>('SELECT kill_switch,revision FROM global_risk_controls WHERE id=1 LIMIT 1')
    return effectivePolicy(userId, accountId, platform, accountRows[0], controls[0])
  }

  async replaceAccountPolicy(input: ReplaceAccountRiskPolicyInput) {
    await transaction(this.pool, async connection => {
      const [owned] = await connection.execute<RowDataPacket[]>(`SELECT a.id FROM trading_accounts a INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE a.id=? FOR UPDATE`, [input.userId, input.accountId])
      if (!owned[0]) throw new RiskError('risk_account_forbidden', 403)
      const [platformRows] = await connection.execute<PolicyRow[]>(policySelect("p.scope='platform'", true))
      const platform = platformRows[0]
      if (!platform) throw new RiskError('risk_platform_policy_missing', 409)
      const [controlRows] = await connection.execute<ControlRow[]>('SELECT kill_switch,revision FROM global_risk_controls WHERE id=1 FOR SHARE')
      const [setRows] = await connection.execute<PolicyRow[]>(policySelect("p.scope='account' AND p.owner_user_id=? AND p.trading_account_id=?", true), [input.userId, input.accountId])
      const current = setRows[0]
      if (Number(current?.set_revision ?? 0) !== input.expectedRevision) throw new RiskError('risk_policy_revision_conflict', 412)
      const currentPatch = current ? parse<AccountRiskPolicyPatch>(current.policy_json) : {}
      const nextPatch = { ...currentPatch, ...input.patch }
      resolveRiskPolicy({
        accountId: input.accountId, userId: input.userId, platformPolicyVersionId: platform.version_id,
        accountPolicyVersionId: current?.version_id ?? null, policySetRevision: input.expectedRevision,
        platform: { values: platformValues(platform.policy_json), globalKillSwitch: Boolean(controlRows[0]?.kill_switch), revision: Number(controlRows[0]?.revision ?? 0) },
        account: nextPatch, updatedAt: input.changedAt,
      })
      let setId = current?.set_id
      if (!setId) {
        const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO risk_policy_sets_v4 (scope,owner_user_id,trading_account_id,name,status,revision,created_at_utc,updated_at_utc) VALUES ('account',?,?,?,'active',0,?,?)`, [input.userId, input.accountId, `Account ${input.accountId} risk policy`, input.changedAt, input.changedAt])
        setId = String(inserted.insertId)
      }
      else await connection.execute('SELECT id FROM risk_policy_sets_v4 WHERE id=? FOR UPDATE', [setId])
      const nextRevision = input.expectedRevision + 1
      const document = JSON.stringify(nextPatch)
      const documentHash = sha256(nextPatch)
      const [versions] = await connection.execute<(RowDataPacket & { version_number: number })[]>('SELECT COALESCE(MAX(version_number),0)+1 version_number FROM risk_policy_versions_v4 WHERE policy_set_id=?', [setId])
      const [version] = await connection.execute<ResultSetHeader>(`INSERT INTO risk_policy_versions_v4 (policy_set_id,version_number,policy_json,policy_sha256,created_by_user_id,change_reason,created_at_utc) VALUES (?,?,?,?,?,?,?)`, [setId, Number(versions[0]?.version_number ?? 1), document, documentHash, input.actorUserId, input.reason, input.changedAt])
      const [updated] = await connection.execute<ResultSetHeader>('UPDATE risk_policy_sets_v4 SET active_version_id=?,revision=?,updated_at_utc=? WHERE id=? AND revision=?', [version.insertId, nextRevision, input.changedAt, setId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new RiskError('risk_policy_revision_conflict', 412)
      for (const key of Object.keys(input.patch).sort()) {
        await connection.execute(`INSERT INTO risk_policy_change_items_v4 (policy_set_id,policy_version_id,field_code,old_value_json,new_value_json,change_class,requested_by_user_id,reason,changed_at_utc) VALUES (?,?,?,?,?,?,?,?,?)`, [setId, version.insertId, key, JSON.stringify(currentPatch[key as keyof AccountRiskPolicyPatch] ?? null), JSON.stringify(input.patch[key as keyof AccountRiskPolicyPatch] ?? null), changeClass(key, currentPatch, input.patch), input.actorUserId, input.reason, input.changedAt])
      }
      await outbox(connection, 'risk_policy', setId, 'risk.policy.changed', { account_id: input.accountId, policy_version_id: String(version.insertId), revision: String(nextRevision) })
      const [releaseRows] = await connection.execute<ManualReleaseRow[]>(`${manualReleaseSelect} WHERE r.trading_account_id=? AND r.status='active' FOR UPDATE`, [input.accountId])
      for (const row of releaseRows) {
        await connection.execute(`UPDATE risk_manual_releases SET status='superseded',invalidated_at_utc=?,invalidation_reason='policy_changed',revision=revision+1 WHERE id=? AND status='active'`, [input.changedAt, row.id])
        await outbox(connection, 'risk_manual_release', row.id, 'risk.manual_release.changed', { manual_release_id: row.id, account_id: row.trading_account_id, status: 'superseded', invalidation_reason: 'policy_changed', revision: String(Number(row.revision) + 1) })
      }
    })
    const policy = await this.getEffectivePolicy(input.userId, input.accountId)
    if (!policy) throw new RiskError('risk_policy_not_found', 404)
    return policy
  }

  async getAccountSummary(userId: number, accountId: string) {
    const [rows] = await this.pool.execute<(PayloadRow & { revision: number })[]>(`SELECT s.payload_json,s.revision FROM account_risk_summaries s INNER JOIN trading_account_ownerships o ON o.trading_account_id=s.trading_account_id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE s.trading_account_id=? LIMIT 1`, [userId, accountId])
    return rows[0] ? { ...parse<AccountRiskSummary>(rows[0].payload_json), revision: Number(rows[0].revision) } : null
  }

  async saveAccountSummary(input: SaveRiskSummaryInput) {
    await transaction(this.pool, async connection => {
      await connection.execute('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [input.summary.accountId])
      const [rows] = await connection.execute<RevisionRow[]>('SELECT revision FROM account_risk_states WHERE trading_account_id=? FOR UPDATE', [input.summary.accountId])
      const previous = rows[0] ? Number(rows[0].revision) : null
      if (previous !== input.expectedRevision || (previous !== null && input.summary.revision <= previous)) throw new RiskError('risk_summary_revision_conflict', 409)
      await connection.execute(`INSERT INTO account_risk_states (trading_account_id,user_id,business_date,equity,free_margin,daily_loss_percent,drawdown_percent,open_positions,pending_orders,total_volume,daily_open_count,consecutive_losses,terminal_timezone_offset_minutes,clock_status,last_successful_open_at_utc,cooldown_until_utc,data_complete,incomplete_reasons_json,observed_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),business_date=VALUES(business_date),equity=VALUES(equity),free_margin=VALUES(free_margin),daily_loss_percent=VALUES(daily_loss_percent),drawdown_percent=VALUES(drawdown_percent),open_positions=VALUES(open_positions),pending_orders=VALUES(pending_orders),total_volume=VALUES(total_volume),daily_open_count=VALUES(daily_open_count),consecutive_losses=VALUES(consecutive_losses),terminal_timezone_offset_minutes=VALUES(terminal_timezone_offset_minutes),clock_status=VALUES(clock_status),last_successful_open_at_utc=VALUES(last_successful_open_at_utc),cooldown_until_utc=VALUES(cooldown_until_utc),data_complete=VALUES(data_complete),incomplete_reasons_json=VALUES(incomplete_reasons_json),observed_at_utc=VALUES(observed_at_utc),revision=VALUES(revision)`, [input.summary.accountId, input.summary.userId, input.summary.businessDate, input.summary.equity, input.summary.freeMargin, input.summary.dailyLossPercent, input.summary.drawdownPercent, input.summary.openPositions, input.summary.pendingOrders, input.summary.totalVolume, input.summary.dailyOpenCount, input.summary.consecutiveLosses, input.summary.terminalTimezoneOffsetMinutes, input.summary.clockStatus, input.summary.lastSuccessfulOpenAt, input.summary.cooldownUntil, input.summary.dataComplete ? 1 : 0, JSON.stringify(input.summary.incompleteReasons), input.summary.observedAt, input.summary.revision])
      const payload = JSON.stringify(input.summary)
      await connection.execute(`INSERT INTO account_risk_summaries (trading_account_id,policy_version_id,payload_json,observed_at_utc,revision) VALUES (?,NULL,?,?,?) ON DUPLICATE KEY UPDATE payload_json=VALUES(payload_json),observed_at_utc=VALUES(observed_at_utc),revision=VALUES(revision)`, [input.summary.accountId, payload, input.summary.observedAt, input.summary.revision])
      await connection.execute(`INSERT INTO risk_state_events (trading_account_id,user_id,event_type,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,?,'summary_projected',?,?,?,?)`, [input.summary.accountId, input.summary.userId, previous, input.summary.revision, payload, input.summary.observedAt])
      await outbox(connection, 'risk_summary', input.summary.accountId, 'risk.summary.changed', { account_id: input.summary.accountId, data_complete: input.summary.dataComplete, revision: String(input.summary.revision) })
      const [releaseRows] = await connection.execute<ManualReleaseRow[]>(`${manualReleaseSelect} WHERE r.trading_account_id=? AND r.status='active' FOR UPDATE`, [input.summary.accountId])
      for (const row of releaseRows) {
        const release = mapManualRelease(row)
        if (manualReleaseStillValid(release, input.summary, new Date(input.summary.observedAt))) continue
        const status = Date.parse(release.expiresAt) <= Date.parse(input.summary.observedAt) ? 'expired' : 'superseded'
        const reason = status === 'expired' ? 'release_expired' : 'risk_state_deteriorated'
        await connection.execute('UPDATE risk_manual_releases SET status=?,invalidated_at_utc=?,invalidation_reason=?,revision=revision+1 WHERE id=? AND status=\'active\'', [status, input.summary.observedAt, reason, release.id])
        await outbox(connection, 'risk_manual_release', release.id, 'risk.manual_release.changed', { manual_release_id: release.id, account_id: release.accountId, status, invalidation_reason: reason, revision: String(release.revision + 1) })
      }
    })
    return input.summary
  }

  async createManualRelease(input: CreateManualRiskReleaseInput) {
    return transaction(this.pool, async connection => {
      const [owned] = await connection.execute<RowDataPacket[]>(`SELECT a.id FROM trading_accounts a INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE a.id=? FOR UPDATE`, [input.release.userId, input.release.accountId])
      if (!owned[0]) throw new RiskError('risk_account_forbidden', 403)
      const [duplicateRows] = await connection.execute<ManualReleaseRow[]>(`${manualReleaseSelect} WHERE r.user_id=? AND r.trading_account_id=? AND r.idempotency_key=? LIMIT 1 FOR UPDATE`, [input.release.userId, input.release.accountId, input.idempotencyKey])
      if (duplicateRows[0]) {
        if (duplicateRows[0].request_sha256 !== input.requestHash) throw new RiskError('idempotency_conflict', 409)
        return mapManualRelease(duplicateRows[0])
      }
      const [stateRows] = await connection.execute<RevisionRow[]>('SELECT revision FROM account_risk_states WHERE trading_account_id=? FOR UPDATE', [input.release.accountId])
      const [summaryRows] = await connection.execute<(PayloadRow & { revision: number })[]>('SELECT payload_json,revision FROM account_risk_summaries WHERE trading_account_id=? FOR UPDATE', [input.release.accountId])
      const summaryRow = summaryRows[0]
      if (!summaryRow || Number(stateRows[0]?.revision) !== input.expectedSummaryRevision || Number(summaryRow.revision) !== input.expectedSummaryRevision) throw new RiskError('risk_summary_revision_conflict', 412)
      const policy = await effectivePolicyOnConnection(connection, input.release.userId, input.release.accountId)
      if (riskPolicyHash(policy) !== input.expectedPolicyHash) throw new RiskError('risk_policy_revision_conflict', 409)
      const summary = { ...parse<AccountRiskSummary>(summaryRow.payload_json), revision: Number(summaryRow.revision) }
      const assessment = assessManualRelease(policy, summary, new Date(input.release.createdAt))
      if (!assessment.available) throw new RiskError(assessment.code, 409)
      if (assessment.breachFingerprint !== input.release.breachFingerprint || JSON.stringify(assessment.rules) !== JSON.stringify(input.release.releasedRules)) throw new RiskError('risk_manual_release_context_conflict', 409)
      const [episodeRows] = await connection.execute<ManualReleaseRow[]>(`${manualReleaseSelect} WHERE r.trading_account_id=? AND r.breach_fingerprint=? LIMIT 1 FOR UPDATE`, [input.release.accountId, input.release.breachFingerprint])
      if (episodeRows[0]) throw new RiskError('risk_manual_release_episode_already_released', 409)
      const [activeRows] = await connection.execute<ManualReleaseRow[]>(`${manualReleaseSelect} WHERE r.trading_account_id=? AND r.status='active' FOR UPDATE`, [input.release.accountId])
      await connection.execute(`UPDATE risk_manual_releases SET status='superseded',invalidated_at_utc=?,invalidation_reason='new_manual_release',revision=revision+1 WHERE trading_account_id=? AND status='active'`, [input.release.createdAt, input.release.accountId])
      for (const row of activeRows) {
        await outbox(connection, 'risk_manual_release', row.id, 'risk.manual_release.changed', { manual_release_id: row.id, account_id: row.trading_account_id, status: 'superseded', invalidation_reason: 'new_manual_release', revision: String(Number(row.revision) + 1) })
      }
      await connection.execute(`INSERT INTO risk_manual_releases (id,user_id,trading_account_id,platform_policy_version_id,account_policy_version_id,policy_set_revision,risk_state_revision,released_rules_json,baseline_json,breach_fingerprint,reason,idempotency_key,request_sha256,status,expires_at_utc,created_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,1)`, [input.release.id, input.release.userId, input.release.accountId, policy.platformPolicyVersionId, policy.accountPolicyVersionId, policy.policySetRevision, input.release.riskStateRevision, JSON.stringify(input.release.releasedRules), JSON.stringify(input.release.baseline), input.release.breachFingerprint, input.release.reason, input.idempotencyKey, input.requestHash, input.release.expiresAt, input.release.createdAt])
      await outbox(connection, 'risk_manual_release', input.release.id, 'risk.manual_release.changed', { manual_release_id: input.release.id, account_id: input.release.accountId, status: 'active', invalidation_reason: null, revision: '1' })
      return input.release
    })
  }

  async getManualRelease(userId: number, accountId: string) {
    const [rows] = await this.pool.execute<ManualReleaseRow[]>(`${manualReleaseSelect} INNER JOIN trading_account_ownerships o ON o.trading_account_id=r.trading_account_id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE r.trading_account_id=? ORDER BY r.created_at_utc DESC,r.id DESC LIMIT 1`, [userId, accountId])
    if (!rows[0]) return null
    const release = mapManualRelease(rows[0])
    return release.status === 'active' && Date.parse(release.expiresAt) <= Date.now()
      ? { ...release, status: 'expired' as const, invalidatedAt: release.expiresAt, invalidationReason: 'release_expired' }
      : release
  }

  async getManualReleaseByIdempotency(userId: number, accountId: string, idempotencyKey: string) {
    const [rows] = await this.pool.execute<ManualReleaseRow[]>(`${manualReleaseSelect} INNER JOIN trading_account_ownerships o ON o.trading_account_id=r.trading_account_id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE r.trading_account_id=? AND r.idempotency_key=? LIMIT 1`, [userId, accountId, idempotencyKey])
    return rows[0] ? { release: mapManualRelease(rows[0]), requestHash: rows[0].request_sha256 } : null
  }

  async loadReviewCandidate(decisionId: string) {
    const [rows] = await this.pool.execute<DecisionCandidateRow[]>(`SELECT d.id,d.user_id,CAST(d.trading_account_id AS CHAR) trading_account_id,d.revision decision_revision,d.status decision_status,d.created_at_utc decision_created_at,p.payload_json decision_payload,a.standard_symbol,a.revision analysis_revision,s.revision subscription_revision,ars.revision account_revision,pr.revision positions_revision,orr.revision pending_orders_revision,q.revision quote_revision,i.revision contract_revision,rs.revision risk_revision,IF(o.user_id IS NULL,0,1) ownership_active,IF(s.status='active',1,0) subscription_active,s.trade_send_enabled subscription_trade_send_enabled,ars.trade_permission account_trade_permission FROM trade_decisions d INNER JOIN trade_decision_payloads p ON p.trade_decision_id=d.id INNER JOIN ai_trader_runs r ON r.id=d.trader_run_id INNER JOIN market_analyses a ON a.id=d.market_analysis_id LEFT JOIN strategy_subscriptions s ON s.id=r.subscription_id AND s.user_id=d.user_id AND s.trading_account_id=d.trading_account_id LEFT JOIN trading_account_ownerships o ON o.user_id=d.user_id AND o.trading_account_id=d.trading_account_id AND o.role='owner' AND o.revoked_at_utc IS NULL LEFT JOIN account_runtime_snapshots ars ON ars.trading_account_id=d.trading_account_id LEFT JOIN trading_projection_revisions pr ON pr.trading_account_id=d.trading_account_id AND pr.resource_kind='positions' AND pr.resource_id='open' LEFT JOIN trading_projection_revisions orr ON orr.trading_account_id=d.trading_account_id AND orr.resource_kind='pending_orders' AND orr.resource_id='open' LEFT JOIN market_quotes q ON q.trading_account_id=d.trading_account_id AND q.symbol=a.standard_symbol LEFT JOIN market_instrument_snapshots i ON i.trading_account_id=d.trading_account_id AND i.symbol=a.standard_symbol LEFT JOIN account_risk_summaries rs ON rs.trading_account_id=d.trading_account_id WHERE d.id=? LIMIT 1`, [decisionId])
    const row = rows[0]
    if (!row || row.decision_status !== 'proposed') return null
    if (!row.ownership_active || !row.subscription_active || !row.account_trade_permission) throw new RiskError('risk_review_authority_changed', 409)
    const policy = await this.getEffectivePolicy(row.user_id, row.trading_account_id)
    const summary = await this.getAccountSummary(row.user_id, row.trading_account_id)
    if (!policy || !summary) throw new RiskError('risk_review_context_incomplete', 409)
    if (!row.subscription_trade_send_enabled) policy.values.tradeSendEnabled = false
    const [quoteRows] = await this.pool.execute<QuoteRow[]>('SELECT symbol,bid,ask,observed_at_utc,revision FROM market_quotes WHERE trading_account_id=? AND symbol=? LIMIT 1', [row.trading_account_id, row.standard_symbol])
    const [instrumentRows] = await this.pool.execute<InstrumentRow[]>('SELECT symbol,payload_json,revision FROM market_instrument_snapshots WHERE trading_account_id=? AND symbol=? LIMIT 1', [row.trading_account_id, row.standard_symbol])
    const [positionRows] = await this.pool.execute<PayloadRow[]>('SELECT payload_json FROM open_position_snapshots WHERE trading_account_id=? ORDER BY ticket', [row.trading_account_id])
    const [orderRows] = await this.pool.execute<PayloadRow[]>('SELECT payload_json FROM pending_order_snapshots WHERE trading_account_id=? ORDER BY ticket', [row.trading_account_id])
    const quote = quoteRows[0]; const instrument = instrumentRows[0]
    if (!quote || !instrument) throw new RiskError('risk_review_market_context_incomplete', 409)
    const result = parse<TraderDecisionResult>(row.decision_payload)
    return {
      decisionId: row.id, decisionRevision: Number(row.decision_revision), decisionCreatedAt: new Date(row.decision_created_at).toISOString(), decisionStatus: 'proposed', result,
      policy, summary,
      quote: { symbol: quote.symbol, bid: String(quote.bid), ask: String(quote.ask), observedAt: new Date(quote.observed_at_utc).toISOString(), revision: Number(quote.revision) },
      instrument: instrumentSnapshot(instrument), positions: positionRows.map(item => parse(item.payload_json)), pendingOrders: orderRows.map(item => parse(item.payload_json)),
      manualRelease: await this.activeManualRelease(row.user_id, row.trading_account_id),
      currentRevisions: { analysis: Number(row.analysis_revision), subscription: Number(row.subscription_revision), account: Number(row.account_revision), positions: Number(row.positions_revision ?? 0), pendingOrders: Number(row.pending_orders_revision ?? 0), quote: Number(row.quote_revision), contract: Number(row.contract_revision), risk: Number(row.risk_revision) },
    } satisfies RiskEvaluationInput
  }

  async completeReview(input: CompleteRiskReviewInput) {
    return transaction(this.pool, async connection => {
      const [ids] = await connection.execute<(RowDataPacket & { trading_account_id: string; user_id: number })[]>('SELECT CAST(trading_account_id AS CHAR) trading_account_id,user_id FROM trade_decisions WHERE id=? LIMIT 1', [input.decisionId])
      const identity = ids[0]
      if (!identity) throw new RiskError('trade_decision_not_found', 404)
      await connection.execute('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [identity.trading_account_id])
      const [decisions] = await connection.execute<(RowDataPacket & { revision: number; status: string; risk_decision_id: string | null })[]>('SELECT revision,status,risk_decision_id FROM trade_decisions WHERE id=? FOR UPDATE', [input.decisionId])
      const decision = decisions[0]
      if (!decision || decision.status !== 'proposed' || Number(decision.revision) !== input.decisionRevision || decision.risk_decision_id) throw new RiskError('risk_trade_decision_revision_conflict', 409)
      const [states] = await connection.execute<RevisionRow[]>('SELECT revision FROM account_risk_states WHERE trading_account_id=? FOR SHARE', [identity.trading_account_id])
      if (Number(states[0]?.revision) !== input.accountRiskRevision) throw new RiskError('risk_summary_revision_conflict', 409)
      const [currentRows] = await connection.execute<(RowDataPacket & { analysis_revision: number; subscription_revision: number; account_revision: number; positions_revision: number; pending_orders_revision: number; quote_revision: number; contract_revision: number; risk_revision: number; risk_payload: string | object })[]>(`SELECT a.revision analysis_revision,s.revision subscription_revision,ars.revision account_revision,COALESCE(pr.revision,0) positions_revision,COALESCE(orr.revision,0) pending_orders_revision,q.revision quote_revision,i.revision contract_revision,rs.revision risk_revision,rs.payload_json risk_payload FROM trade_decisions d INNER JOIN ai_trader_runs r ON r.id=d.trader_run_id INNER JOIN market_analyses a ON a.id=d.market_analysis_id INNER JOIN strategy_subscriptions s ON s.id=r.subscription_id LEFT JOIN account_runtime_snapshots ars ON ars.trading_account_id=d.trading_account_id LEFT JOIN trading_projection_revisions pr ON pr.trading_account_id=d.trading_account_id AND pr.resource_kind='positions' AND pr.resource_id='open' LEFT JOIN trading_projection_revisions orr ON orr.trading_account_id=d.trading_account_id AND orr.resource_kind='pending_orders' AND orr.resource_id='open' LEFT JOIN market_quotes q ON q.trading_account_id=d.trading_account_id AND q.symbol=a.standard_symbol LEFT JOIN market_instrument_snapshots i ON i.trading_account_id=d.trading_account_id AND i.symbol=a.standard_symbol LEFT JOIN account_risk_summaries rs ON rs.trading_account_id=d.trading_account_id WHERE d.id=? LIMIT 1 FOR SHARE`, [input.decisionId])
      const current = currentRows[0]
      if (!current || Number(current.analysis_revision) !== input.expectedRevisions.analysis
        || Number(current.subscription_revision) !== input.expectedRevisions.subscription
        || Number(current.account_revision) !== input.expectedRevisions.account
        || Number(current.positions_revision) !== input.expectedRevisions.positions
        || Number(current.pending_orders_revision) !== input.expectedRevisions.pendingOrders
        || Number(current.quote_revision) !== input.expectedRevisions.quote
        || Number(current.contract_revision) !== input.expectedRevisions.contract
        || Number(current.risk_revision) !== input.expectedRevisions.risk) throw new RiskError('risk_review_context_revision_conflict', 409)
      const policy = await effectivePolicyOnConnection(connection, identity.user_id, identity.trading_account_id)
      if (policy.policySetRevision !== input.policySetRevision || riskPolicyHash(policy) !== input.evaluation.policyHash) throw new RiskError('risk_policy_revision_conflict', 409)
      if (input.evaluation.manualReleaseId) {
        const [releaseRows] = await connection.execute<ManualReleaseRow[]>(`${manualReleaseSelect} WHERE r.id=? AND r.trading_account_id=? AND r.status='active' LIMIT 1 FOR SHARE`, [input.evaluation.manualReleaseId, identity.trading_account_id])
        const release = releaseRows[0] ? mapManualRelease(releaseRows[0]) : null
        const summary = { ...parse<AccountRiskSummary>(current.risk_payload), revision: Number(current.risk_revision) }
        if (!release || release.revision !== input.evaluation.manualReleaseRevision
          || release.platformPolicyVersionId !== policy.platformPolicyVersionId
          || release.accountPolicyVersionId !== policy.accountPolicyVersionId
          || release.policySetRevision !== policy.policySetRevision
          || !manualReleaseStillValid(release, summary, new Date())) throw new RiskError('risk_manual_release_revision_conflict', 409)
      }
      const payload = JSON.stringify(input.evaluation)
      await connection.execute(`INSERT INTO risk_decisions_v4 (id,trade_decision_id,user_id,trading_account_id,platform_policy_version_id,account_policy_version_id,policy_set_revision,account_risk_revision,manual_release_id,decision_status,reject_code,policy_sha256,revision,created_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`, [input.riskDecisionId, input.decisionId, identity.user_id, identity.trading_account_id, policy.platformPolicyVersionId, policy.accountPolicyVersionId, policy.policySetRevision, input.accountRiskRevision, input.evaluation.manualReleaseId, input.evaluation.status, input.evaluation.rejectCode, input.evaluation.policyHash, input.evaluation.evaluatedAt])
      await connection.execute('INSERT INTO risk_decision_payloads_v4 (risk_decision_id,evaluation_json,payload_sha256,payload_bytes) VALUES (?,?,?,?)', [input.riskDecisionId, payload, sha256(input.evaluation), Buffer.byteLength(payload)])
      const tradeStatus = input.evaluation.status === 'approved' ? 'accepted' : 'risk_rejected'
      await connection.execute('UPDATE trade_decisions SET risk_decision_id=?,status=?,revision=revision+1 WHERE id=?', [input.riskDecisionId, tradeStatus, input.decisionId])
      await outbox(connection, 'risk_decision', input.riskDecisionId, 'risk.decision.created', { risk_decision_id: input.riskDecisionId, decision_id: input.decisionId, user_id: identity.user_id, account_id: identity.trading_account_id, status: input.evaluation.status, reject_code: input.evaluation.rejectCode })
      const [created] = await connection.execute<RiskDecisionRow[]>(`${riskDecisionSelect} WHERE rd.id=?`, [input.riskDecisionId])
      return mapDecision(created[0]!)
    })
  }

  async getDecision(userId: number, decisionId: string) {
    const [rows] = await this.pool.execute<RiskDecisionDetailRow[]>(`SELECT ${riskDecisionFields},p.evaluation_json FROM risk_decisions_v4 rd INNER JOIN risk_decision_payloads_v4 p ON p.risk_decision_id=rd.id WHERE rd.id=? AND rd.user_id=? LIMIT 1`, [decisionId, userId])
    return rows[0] ? { ...mapDecision(rows[0]), evaluation: parse<RiskEvaluationResult>(rows[0].evaluation_json) } : null
  }

  async listDecisions(userId: number, accountId: string, limit: number) {
    const [rows] = await this.pool.execute<RiskDecisionRow[]>(`${riskDecisionSelect} WHERE rd.user_id=? AND rd.trading_account_id=? ORDER BY rd.created_at_utc DESC,rd.id DESC LIMIT ?`, [userId, accountId, limit])
    return rows.map(mapDecision)
  }

  private async activeManualRelease(userId: number, accountId: string) {
    const [rows] = await this.pool.execute<ManualReleaseRow[]>(`${manualReleaseSelect} WHERE r.user_id=? AND r.trading_account_id=? AND r.status='active' AND r.expires_at_utc>UTC_TIMESTAMP(3) ORDER BY r.created_at_utc DESC,r.id DESC LIMIT 1`, [userId, accountId])
    return rows[0] ? mapManualRelease(rows[0]) : null
  }
}

const riskDecisionFields = `rd.id,rd.trade_decision_id,rd.user_id,CAST(rd.trading_account_id AS CHAR) trading_account_id,rd.decision_status,rd.reject_code,CAST(rd.platform_policy_version_id AS CHAR) platform_policy_version_id,CAST(rd.account_policy_version_id AS CHAR) account_policy_version_id,rd.account_risk_revision,rd.manual_release_id,rd.created_at_utc,rd.revision`
const riskDecisionSelect = `SELECT ${riskDecisionFields} FROM risk_decisions_v4 rd`
const manualReleaseFields = `r.id,r.user_id,CAST(r.trading_account_id AS CHAR) trading_account_id,CAST(r.platform_policy_version_id AS CHAR) platform_policy_version_id,CAST(r.account_policy_version_id AS CHAR) account_policy_version_id,r.policy_set_revision,r.status,r.released_rules_json,r.baseline_json,r.risk_state_revision,r.breach_fingerprint,r.reason,r.expires_at_utc,r.created_at_utc,r.invalidated_at_utc,r.invalidation_reason,r.revision,r.request_sha256`
const manualReleaseSelect = `SELECT ${manualReleaseFields} FROM risk_manual_releases r`

function policySelect(where: string, lock = false) {
  return `SELECT CAST(p.id AS CHAR) set_id,p.scope,p.owner_user_id,CAST(p.trading_account_id AS CHAR) trading_account_id,p.revision set_revision,CAST(v.id AS CHAR) version_id,v.policy_json,p.updated_at_utc FROM risk_policy_sets_v4 p INNER JOIN risk_policy_versions_v4 v ON v.id=p.active_version_id AND v.policy_set_id=p.id WHERE p.status='active' AND ${where} LIMIT 1${lock ? ' FOR SHARE' : ''}`
}

async function effectivePolicyOnConnection(connection: PoolConnection, userId: number, accountId: string) {
  const [platformRows] = await connection.execute<PolicyRow[]>(policySelect("p.scope='platform'", true))
  const [accountRows] = await connection.execute<PolicyRow[]>(policySelect("p.scope='account' AND p.owner_user_id=? AND p.trading_account_id=?", true), [userId, accountId])
  const [controls] = await connection.execute<ControlRow[]>('SELECT kill_switch,revision FROM global_risk_controls WHERE id=1 FOR SHARE')
  if (!platformRows[0]) throw new RiskError('risk_platform_policy_missing', 409)
  return effectivePolicy(userId, accountId, platformRows[0], accountRows[0], controls[0])
}

function effectivePolicy(userId: number, accountId: string, platform: PolicyRow, account: PolicyRow | undefined, control: ControlRow | undefined): EffectiveRiskPolicy {
  return resolveRiskPolicy({
    accountId, userId, platformPolicyVersionId: platform.version_id, accountPolicyVersionId: account?.version_id ?? null,
    policySetRevision: Number(account?.set_revision ?? 0),
    platform: { values: platformValues(platform.policy_json), globalKillSwitch: Boolean(control?.kill_switch), revision: Number(control?.revision ?? 0) },
    account: account ? parse<AccountRiskPolicyPatch>(account.policy_json) : null,
    updatedAt: new Date(account?.updated_at_utc ?? platform.updated_at_utc).toISOString(),
  })
}

function platformValues(value: string | object) {
  const parsed = parse<Partial<typeof DEFAULT_RISK_POLICY> & { values?: Partial<typeof DEFAULT_RISK_POLICY> }>(value)
  return { ...DEFAULT_RISK_POLICY, ...(parsed.values ?? parsed), allowedSymbols: [...(parsed.values?.allowedSymbols ?? parsed.allowedSymbols ?? DEFAULT_RISK_POLICY.allowedSymbols)], requireStopLoss: true as const, failClosedOnIncompleteData: true as const }
}

function instrumentSnapshot(row: InstrumentRow): RiskInstrumentSnapshot {
  const value = parse<Record<string, unknown>>(row.payload_json)
  const get = (camel: string, snake: string) => String(value[camel] ?? value[snake] ?? '')
  return { symbol: row.symbol, point: get('point', 'point'), tickSize: get('tickSize', 'tick_size'), tickValue: get('tickValue', 'tick_value'), volumeMin: get('volumeMin', 'volume_min'), volumeMax: get('volumeMax', 'volume_max'), volumeStep: get('volumeStep', 'volume_step'), tradeEnabled: parseTradeEnabled(value), revision: Number(row.revision) }
}

function parseTradeEnabled(value: Record<string, unknown>) {
  if (typeof value.tradeEnabled === 'boolean') return value.tradeEnabled
  const mode = value.trade_mode
  if (typeof mode === 'number') return Number.isFinite(mode) && mode > 0
  if (typeof mode !== 'string') return false
  const normalized = mode.trim().toLowerCase()
  if (/^\d+$/.test(normalized)) return Number(normalized) > 0
  return ['full', 'enabled', 'long_only', 'short_only'].includes(normalized)
}

function mapDecision(row: RiskDecisionRow): RiskDecisionSummary {
  return { id: row.id, tradeDecisionId: row.trade_decision_id, userId: row.user_id, accountId: row.trading_account_id, status: row.decision_status, rejectCode: row.reject_code, platformPolicyVersionId: row.platform_policy_version_id, accountPolicyVersionId: row.account_policy_version_id, accountRiskRevision: Number(row.account_risk_revision), manualReleaseId: row.manual_release_id, createdAt: new Date(row.created_at_utc).toISOString(), revision: Number(row.revision) }
}

function mapManualRelease(row: ManualReleaseRow): ManualRiskRelease {
  return {
    id: row.id, userId: Number(row.user_id), accountId: row.trading_account_id,
    platformPolicyVersionId: row.platform_policy_version_id, accountPolicyVersionId: row.account_policy_version_id,
    policySetRevision: Number(row.policy_set_revision), status: row.status,
    releasedRules: parse<ManualReleaseRuleCode[]>(row.released_rules_json), baseline: parse(row.baseline_json),
    riskStateRevision: Number(row.risk_state_revision), breachFingerprint: row.breach_fingerprint, reason: row.reason,
    expiresAt: new Date(row.expires_at_utc).toISOString(), createdAt: new Date(row.created_at_utc).toISOString(),
    invalidatedAt: row.invalidated_at_utc ? new Date(row.invalidated_at_utc).toISOString() : null,
    invalidationReason: row.invalidation_reason, revision: Number(row.revision),
  }
}

function changeClass(key: string, current: AccountRiskPolicyPatch, patch: AccountRiskPolicyPatch): 'tighten' | 'relax_within_platform' | 'toggle' {
  if (key === 'tradeSendEnabled' || key === 'accountKillSwitch') return 'toggle'
  const before = Number(current[key as keyof AccountRiskPolicyPatch] ?? 0); const after = Number(patch[key as keyof AccountRiskPolicyPatch] ?? before)
  return after <= before ? 'tighten' : 'relax_within_platform'
}

async function outbox(connection: PoolConnection, aggregateType: string, aggregateId: string, eventType: string, payload: object) {
  await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(), aggregateType, aggregateId, eventType, JSON.stringify(payload)])
}

function parse<T = Record<string, unknown>>(value: string | object): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T }
function sha256(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex') }
function canonical(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}` }
