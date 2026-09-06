import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { CreateManualReviewInput, ReviewJobClaim, ReviewRepository, ReviewWorkerRepository } from '../application/review-ports.js'
import { ReviewError, type ManualReviewCandidate, type ReviewCaseDetail, type ReviewCaseSummary, type ReviewContent, type ReviewJobSummary, type ReviewSource, type ReviewVersion, type StrategyMemoryDetail, type StrategyMemorySummary, type StrategyMemoryUpdate } from '../domain/review.js'

interface CaseRow extends RowDataPacket {
  id: string; kind: ReviewCaseSummary['kind']; user_id: number; trading_account_id: string; account_label: string
  standard_symbol: string | null; subscription_id: string | null; subscription_revision: number | null; analysis_strategy_id: string | null; analysis_strategy_name: string | null
  trader_strategy_id: string | null; trader_strategy_name: string | null; terminal_period_start_utc: Date
  terminal_period_end_utc: Date; terminal_timezone_offset_minutes: number; status: ReviewCaseSummary['status']
  evidence_status: ReviewCaseSummary['evidenceStatus']; evidence_revision: number; evidence_sha256: string | null
  current_version_id: string | null; confirmed_version_id: string | null; updated_at_utc: Date; revision: number; return_reason: string | null
}
interface VersionRow extends RowDataPacket {
  id: string; review_case_id: string; version_number: number; author_kind: 'ai' | 'user'; conclusion_code: ReviewVersion['conclusion']
  content_json: string | object; full_analysis_text: string; created_at_utc: Date
}
interface SourceRow extends RowDataPacket { source_kind: ReviewSource['kind']; source_id: string; relation_kind: ReviewSource['relation']; source_sha256: string }
interface JobRow extends RowDataPacket {
  id: string; generation: number; mode: ReviewJobSummary['mode']; status: ReviewJobSummary['status']; progress_percent: number
  current_stage: string; last_error_code: string | null; updated_at_utc: Date
}
interface CandidateRow extends RowDataPacket {
  id: string; trading_account_id: string; account_label: string; ticket: string; position_id: string | null; symbol: string
  side: 'buy' | 'sell'; volume: string; opened_at_utc: Date; closed_at_utc: Date; net_profit: string
  terminal_timezone_offset_minutes: number
  source_classification: ManualReviewCandidate['sourceClassification']; eligibility_status: ManualReviewCandidate['eligibilityStatus']
  evidence_sha256: string; selection_token_sha256: string; selection_expires_at_utc: Date; revision: number
}
interface MemoryRow extends RowDataPacket {
  id: string; strategy_id: string; strategy_name: string; strategy_kind: 'analysis' | 'trader'; owner_user_id: number | null
  mode: StrategyMemorySummary['mode']; status: StrategyMemorySummary['status']; current_revision_id: string | null
  current_version_number: number | null; content_text: string | null; content_sha256: string | null; max_context_tokens: number
  pending_count: number; updated_at_utc: Date; revision: number
}
interface MemoryUpdateRow extends RowDataPacket {
  id: string; library_id: string; source_review_case_id: string; source_review_version_id: string
  update_kind: StrategyMemoryUpdate['updateKind']; proposal_key: string; status: StrategyMemoryUpdate['status']; expected_library_revision: number
  proposal_json: string | object; diff_preview_text: string; conflict_json: string | unknown[]; created_at_utc: Date; revision: number
}
interface MemoryDecisionRow extends MemoryUpdateRow {
  owner_user_id: number | null
  library_revision: number
  current_version_number: number | null
  content_text: string | null
  content_json: string | MemoryDocument | null
}

interface MemoryDocument { schema_version: 'strategy_memory.v4.1'; blocks: MemoryBlock[] }
interface MemoryBlock { kind: 'legacy_snapshot' | 'review_memory'; content: string; memory_update_id?: string }
interface ReviewJobContextRow extends RowDataPacket {
  job_id: string; case_id: string; user_id: number; trading_account_id: string; kind: ReviewJobClaim['kind']; generation: number
  evidence_revision: number; input_sha256: string; evidence_sha256: string; evidence_json: string | Record<string, unknown>
  strategy_id: string; analysis_prompt: string | null; trader_prompt: string | null; status: string; lease_expires_at_utc: Date | null
  analysis_strategy_id: string | null; trader_strategy_id: string | null
  fencing_token: number; case_revision: number; current_version_id: string | null; next_attempt_number: number; source_refs: string | string[] | null
}

const caseSelect = `SELECT c.id,c.kind,c.user_id,CAST(c.trading_account_id AS CHAR) trading_account_id,CONCAT(a.platform,' · ',a.account_login,' · ',a.broker_server) account_label,c.standard_symbol,CAST(c.subscription_id AS CHAR) subscription_id,c.subscription_revision,CAST(c.analysis_strategy_id AS CHAR) analysis_strategy_id,sa.name analysis_strategy_name,CAST(c.trader_strategy_id AS CHAR) trader_strategy_id,st.name trader_strategy_name,c.terminal_period_start_utc,c.terminal_period_end_utc,c.terminal_timezone_offset_minutes,c.status,c.evidence_status,c.evidence_revision,c.evidence_sha256,c.current_version_id,c.confirmed_version_id,c.updated_at_utc,c.revision,c.return_reason FROM review_cases_v4 c INNER JOIN trading_accounts a ON a.id=c.trading_account_id LEFT JOIN strategies sa ON sa.id=c.analysis_strategy_id LEFT JOIN strategies st ON st.id=c.trader_strategy_id`
const memorySelect = `SELECT l.id,CAST(l.strategy_id AS CHAR) strategy_id,s.name strategy_name,s.kind strategy_kind,l.owner_user_id,l.mode,l.status,l.current_revision_id,r.version_number current_version_number,r.content_text,r.content_sha256,l.max_context_tokens,(SELECT COUNT(*) FROM strategy_memory_pending_updates_v4 u WHERE u.library_id=l.id AND u.status='awaiting_confirmation') pending_count,l.updated_at_utc,l.revision FROM strategy_memory_libraries_v4 l INNER JOIN strategies s ON s.id=l.strategy_id LEFT JOIN strategy_memory_library_revisions_v4 r ON r.id=l.current_revision_id AND r.library_id=l.id`

const candidateColumns = `m.id,CAST(m.trading_account_id AS CHAR) trading_account_id,CONCAT(a.platform,' · ',a.account_login,' · ',a.broker_server) account_label,m.ticket,m.position_id,m.symbol,m.side,m.volume,m.opened_at_utc,m.closed_at_utc,m.net_profit,m.terminal_timezone_offset_minutes,m.source_classification,m.eligibility_status,m.evidence_sha256,m.selection_token_sha256,m.selection_expires_at_utc,m.revision`
const memoryUpdateColumns = `u.id,u.library_id,u.source_review_case_id,u.source_review_version_id,u.update_kind,u.proposal_key,u.status,u.expected_library_revision,u.proposal_json,u.diff_preview_text,u.conflict_json,u.created_at_utc,u.revision`
type CaseLockRow = RowDataPacket & Pick<CaseRow, 'revision' | 'status' | 'evidence_status' | 'evidence_sha256' | 'evidence_revision' | 'current_version_id'>

export class MysqlReviewRepository implements ReviewRepository, ReviewWorkerRepository {
  constructor(private readonly pool: Pool) {}

  async listCases(userId: number, filter: Parameters<ReviewRepository['listCases']>[1]) {
    const where = ['c.user_id=?']; const values: Array<string | number> = [userId]
    if (filter.kind) { where.push('c.kind=?'); values.push(filter.kind) }
    if (filter.tradingAccountId) { where.push('c.trading_account_id=?'); values.push(filter.tradingAccountId) }
    values.push(filter.limit)
    const [rows] = await this.pool.execute<CaseRow[]>(`${caseSelect} WHERE ${where.join(' AND ')} ORDER BY c.terminal_period_end_utc DESC,c.id DESC LIMIT ?`, values)
    return rows.map(caseDto)
  }

  async getCase(userId: number, caseId: string) { return loadDetail(this.pool, userId, caseId) }

  async listManualCandidates(userId: number, tradingAccountId: string | undefined, limit: number) {
    const where = [`m.user_id=?`, `m.source_classification='manual'`]; const values: Array<string | number> = [userId]
    if (tradingAccountId) { where.push('m.trading_account_id=?'); values.push(tradingAccountId) }
    values.push(limit)
    const [rows] = await this.pool.execute<CandidateRow[]>(`SELECT ${candidateColumns} FROM manual_review_candidates_v4 m INNER JOIN trading_accounts a ON a.id=m.trading_account_id INNER JOIN trading_account_ownerships o ON o.trading_account_id=m.trading_account_id AND o.user_id=m.user_id AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE ${where.join(' AND ')} ORDER BY m.closed_at_utc DESC,m.id DESC LIMIT ?`, values)
    return rows.map(candidateDto)
  }

  async createManualCase(input: CreateManualReviewInput) {
    const caseId = await transaction(this.pool, async connection => {
      const scopeKey = `manual:${sha256({ userId: input.userId, idempotencyKey: input.idempotencyKey })}`
      const [existing] = await connection.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM review_cases_v4 WHERE user_id=? AND kind=\'manual\' AND scope_key=? LIMIT 1', [input.userId, scopeKey])
      if (existing[0]) return existing[0].id
      const placeholders = input.candidateIds.map(() => '?').join(',')
      const [rows] = await connection.execute<CandidateRow[]>(`SELECT ${candidateColumns} FROM manual_review_candidates_v4 m INNER JOIN trading_accounts a ON a.id=m.trading_account_id INNER JOIN trading_account_ownerships o ON o.trading_account_id=m.trading_account_id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE m.id IN (${placeholders}) FOR UPDATE`, [input.userId, ...input.candidateIds])
      if (rows.length !== input.candidateIds.length) throw new ReviewError('manual_review_candidate_not_found', 404)
      const [replayed] = await connection.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM review_cases_v4 WHERE user_id=? AND kind=\'manual\' AND scope_key=? LIMIT 1 FOR SHARE', [input.userId, scopeKey])
      if (replayed[0]) return replayed[0].id
      const byId = new Map(rows.map(row => [row.id, row]))
      const candidates = input.candidateIds.map((candidateId, index) => {
        const row = byId.get(candidateId)!
        if (row.source_classification !== 'manual') throw new ReviewError('manual_review_source_not_manual', 409)
        if (row.eligibility_status !== 'eligible') throw new ReviewError('manual_review_candidate_not_eligible', 409)
        if (row.selection_expires_at_utc.getTime() <= new Date(input.now).getTime()) throw new ReviewError('manual_review_selection_expired', 409)
        if (row.selection_token_sha256 !== input.selectionTokens[index]) throw new ReviewError('manual_review_selection_changed', 409)
        return row
      })
      if (new Set(candidates.map(row => row.trading_account_id)).size !== 1) throw new ReviewError('manual_review_account_mixed', 422)
      const [strategies] = await connection.execute<RowDataPacket[]>(`SELECT id,kind,owner_user_id,CAST(active_version_id AS CHAR) active_version_id FROM strategies WHERE id=? AND (scope='platform' OR owner_user_id=?) AND status='active' AND active_version_id IS NOT NULL AND deleted_at_utc IS NULL LIMIT 1 FOR SHARE`, [input.strategyId, input.userId])
      if (!strategies[0]) throw new ReviewError('manual_review_strategy_not_found', 404)
      const id = randomUUID(); const jobId = randomUUID()
      const ordered = [...candidates].sort((a, b) => a.opened_at_utc.getTime() - b.opened_at_utc.getTime() || a.id.localeCompare(b.id))
      const evidence = {
        schema_version: 'review-evidence.v4.1', source: 'manual_trade', user_thesis: input.userThesis,
        trades: ordered.map(row => ({ candidate_id: row.id, account_id: row.trading_account_id, ticket: row.ticket, position_id: row.position_id, symbol: row.symbol, side: row.side, volume: String(row.volume), opened_at: utc(row.opened_at_utc), closed_at: utc(row.closed_at_utc), net_profit: String(row.net_profit), evidence_sha256: row.evidence_sha256 })),
      }
      const evidenceJson = JSON.stringify(evidence); const evidenceHash = sha256(evidence)
      const openedAt = ordered[0]!.opened_at_utc; const latest = ordered.reduce((current, row) => row.closed_at_utc > current.closed_at_utc ? row : current, ordered[0]!); const closedAt = latest.closed_at_utc
      const strategy = strategies[0] as { kind: 'analysis' | 'trader'; active_version_id: string }
      await connection.execute(`INSERT INTO review_cases_v4 (id,user_id,trading_account_id,kind,scope_key,standard_symbol,analysis_strategy_id,analysis_strategy_version_id,trader_strategy_id,trader_strategy_version_id,terminal_period_start_utc,terminal_period_end_utc,terminal_timezone_offset_minutes,status,evidence_status,evidence_revision,evidence_sha256,review_eligible_at_utc,created_at_utc,updated_at_utc,revision) VALUES (?,?,?,'manual',?,?,?,?,?,?,?,?,?,'queued','complete',1,?,?,?,?,1)`, [id, input.userId, ordered[0]!.trading_account_id, scopeKey, new Set(ordered.map(row => row.symbol)).size === 1 ? ordered[0]!.symbol : null, strategy.kind === 'analysis' ? input.strategyId : null, strategy.kind === 'analysis' ? strategy.active_version_id : null, strategy.kind === 'trader' ? input.strategyId : null, strategy.kind === 'trader' ? strategy.active_version_id : null, openedAt, closedAt, latest.terminal_timezone_offset_minutes, evidenceHash, input.now, input.now, input.now])
      await connection.execute(`INSERT INTO review_evidence_payloads_v4 (review_case_id,evidence_revision,evidence_json,evidence_sha256,payload_bytes,created_at_utc) VALUES (?,1,?,?,?,?)`, [id, evidenceJson, evidenceHash, Buffer.byteLength(evidenceJson), input.now])
      for (const row of ordered) await connection.execute(`INSERT INTO review_case_sources_v4 (review_case_id,source_kind,source_id,relation_kind,source_sha256,source_metadata_json,created_at_utc) VALUES (?,'terminal_trade',?,'direct',?,?,?)`, [id, row.id, row.evidence_sha256, JSON.stringify({ ticket: row.ticket, position_id: row.position_id }), input.now])
      await connection.execute(`UPDATE manual_review_candidates_v4 SET eligibility_status='already_reviewed',revision=revision+1 WHERE user_id=? AND id IN (${placeholders}) AND eligibility_status='eligible'`, [input.userId, ...input.candidateIds])
      await connection.execute(`INSERT INTO review_jobs_v4 (id,review_case_id,generation,mode,status,evidence_revision,input_sha256,progress_percent,current_stage,created_at_utc,updated_at_utc,revision) VALUES (?,?,1,'initial','queued',1,?,0,'queued',?,?,1)`, [jobId, id, evidenceHash, input.now, input.now])
      await jobEvent(connection, jobId, 'review_queued', null, 'queued', {}, input.now)
      await outbox(connection, 'review_job', jobId, 'review.job.requested', { review_job_id: jobId, review_case_id: id, generation: 1 })
      await outbox(connection, 'review_case', id, 'review.case.changed', { review_case_id: id, status: 'queued', current_version_id: null, revision: '1' })
      return id
    })
    return (await loadDetail(this.pool, input.userId, caseId))!
  }

  async requestGeneration(input: Parameters<ReviewRepository['requestGeneration']>[0]) {
    if (input.mode === 'refresh_evidence') throw new ReviewError('review_evidence_refresh_requires_collector', 409)
    await transaction(this.pool, async connection => {
      const row = await lockCase(connection, input.userId, input.caseId)
      if (Number(row.revision) !== input.expectedRevision) throw new ReviewError('review_revision_conflict', 412)
      if (row.evidence_status !== 'complete' || !row.evidence_sha256) throw new ReviewError('review_evidence_incomplete', 409)
      const [active] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM review_jobs_v4 WHERE review_case_id=? AND status IN ('queued','preparing_evidence','waiting_model','validating','retry_wait') LIMIT 1 FOR UPDATE`, [input.caseId])
      if (active[0]) throw new ReviewError('review_generation_active', 409)
      const [generations] = await connection.execute<(RowDataPacket & { generation: number })[]>('SELECT COALESCE(MAX(generation),0)+1 generation FROM review_jobs_v4 WHERE review_case_id=?', [input.caseId])
      const generation = Number(generations[0]?.generation ?? 1); const jobId = randomUUID()
      await connection.execute(`INSERT INTO review_jobs_v4 (id,review_case_id,generation,mode,status,evidence_revision,input_sha256,progress_percent,current_stage,created_at_utc,updated_at_utc,revision) VALUES (?,?,?,'retry','queued',?,?,0,'queued',?,?,1)`, [jobId, input.caseId, generation, row.evidence_revision, row.evidence_sha256, input.now, input.now])
      await connection.execute(`UPDATE review_cases_v4 SET status='queued',return_reason=NULL,updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [input.now, input.caseId, input.expectedRevision])
      await jobEvent(connection, jobId, 'review_queued', null, 'queued', {}, input.now)
      await outbox(connection, 'review_job', jobId, 'review.job.requested', { review_job_id: jobId, review_case_id: input.caseId, generation })
      await outbox(connection, 'review_case', input.caseId, 'review.case.changed', { review_case_id: input.caseId, status: 'queued', current_version_id: row.current_version_id, revision: String(input.expectedRevision + 1) })
    })
    return (await loadDetail(this.pool, input.userId, input.caseId))!
  }

  async createUserVersion(input: Parameters<ReviewRepository['createUserVersion']>[0]) {
    await transaction(this.pool, async connection => {
      const row = await lockCase(connection, input.userId, input.caseId)
      if (Number(row.revision) !== input.expectedRevision) throw new ReviewError('review_revision_conflict', 412)
      if (row.evidence_status !== 'complete' || !row.current_version_id || !['awaiting_confirmation', 'needs_changes'].includes(row.status)) throw new ReviewError('review_version_edit_unavailable', 409)
      await assertCaseEvidenceRefs(connection, input.caseId, input.content.evidenceRefs)
      const [numbers] = await connection.execute<(RowDataPacket & { version_number: number })[]>('SELECT COALESCE(MAX(version_number),0)+1 version_number FROM review_versions_v4 WHERE review_case_id=?', [input.caseId])
      const versionId = randomUUID(); const content = JSON.stringify({ ...input.content, fullAnalysisText: undefined }); const payloadHash = sha256({ content: input.content, full: input.content.fullAnalysisText })
      await connection.execute(`INSERT INTO review_versions_v4 (id,review_case_id,version_number,source_job_id,author_kind,created_by_user_id,conclusion_code,net_profit,trade_count,win_rate_percent,profit_factor,content_sha256,created_at_utc) VALUES (?,?,?,NULL,'user',?,?,?,?,?,?,?,?)`, [versionId, input.caseId, Number(numbers[0]?.version_number ?? 1), input.userId, input.content.conclusion, input.content.metrics.netProfit, input.content.metrics.tradeCount, input.content.metrics.winRatePercent, input.content.metrics.profitFactor, payloadHash, input.now])
      await connection.execute(`INSERT INTO review_version_payloads_v4 (review_version_id,content_json,full_analysis_text,payload_sha256,payload_bytes) VALUES (?,?,?,?,?)`, [versionId, content, input.content.fullAnalysisText, payloadHash, Buffer.byteLength(content) + Buffer.byteLength(input.content.fullAnalysisText)])
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE review_cases_v4 SET current_version_id=?,confirmed_version_id=NULL,confirmed_by_user_id=NULL,confirmed_at_utc=NULL,status='awaiting_confirmation',updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [versionId, input.now, input.caseId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new ReviewError('review_revision_conflict', 412)
      await outbox(connection, 'review_case', input.caseId, 'review.case.changed', { review_case_id: input.caseId, status: 'awaiting_confirmation', current_version_id: versionId, revision: String(input.expectedRevision + 1) })
    })
    return (await loadDetail(this.pool, input.userId, input.caseId))!
  }

  async confirmVersion(input: Parameters<ReviewRepository['confirmVersion']>[0]) {
    await transaction(this.pool, async connection => {
      const row = await lockCase(connection, input.userId, input.caseId)
      if (Number(row.revision) !== input.expectedRevision) throw new ReviewError('review_revision_conflict', 412)
      if (row.status !== 'awaiting_confirmation' || row.evidence_status !== 'complete' || row.current_version_id !== input.versionId) throw new ReviewError('review_confirmation_version_stale', 409)
      const [versions] = await connection.execute<VersionRow[]>(`SELECT v.id,v.review_case_id,v.version_number,v.author_kind,v.conclusion_code,p.content_json,p.full_analysis_text,v.created_at_utc FROM review_versions_v4 v INNER JOIN review_version_payloads_v4 p ON p.review_version_id=v.id WHERE v.id=? AND v.review_case_id=? FOR SHARE`, [input.versionId, input.caseId])
      const version = versions[0]
      if (!version) throw new ReviewError('review_version_not_found', 404)
      const content = reviewContent(version)
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE review_cases_v4 SET confirmed_version_id=?,confirmed_by_user_id=?,confirmed_at_utc=?,status='confirmed',return_reason=NULL,updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [input.versionId, input.userId, input.now, input.now, input.caseId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new ReviewError('review_revision_conflict', 412)
      for (const candidate of content.memoryCandidates) await createPendingMemoryUpdate(connection, input, candidate)
      await outbox(connection, 'review_case', input.caseId, 'review.case.changed', { review_case_id: input.caseId, status: 'confirmed', current_version_id: input.versionId, revision: String(input.expectedRevision + 1) })
    })
    return (await loadDetail(this.pool, input.userId, input.caseId))!
  }

  async returnCase(input: Parameters<ReviewRepository['returnCase']>[0]) {
    await transaction(this.pool, async connection => {
      const row = await lockCase(connection, input.userId, input.caseId)
      if (Number(row.revision) !== input.expectedRevision) throw new ReviewError('review_revision_conflict', 412)
      if (row.status !== 'awaiting_confirmation' || !row.current_version_id) throw new ReviewError('review_version_not_found', 409)
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE review_cases_v4 SET status='needs_changes',confirmed_version_id=NULL,confirmed_by_user_id=NULL,confirmed_at_utc=NULL,return_reason=?,updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [input.reason, input.now, input.caseId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new ReviewError('review_revision_conflict', 412)
      await outbox(connection, 'review_case', input.caseId, 'review.case.changed', { review_case_id: input.caseId, status: 'needs_changes', current_version_id: row.current_version_id, revision: String(input.expectedRevision + 1) })
    })
    return (await loadDetail(this.pool, input.userId, input.caseId))!
  }

  async listMemories(userId: number) {
    const [rows] = await this.pool.execute<MemoryRow[]>(`${memorySelect} WHERE (l.owner_user_id=? OR (l.owner_user_id IS NULL AND s.scope='platform')) ORDER BY l.updated_at_utc DESC,l.id`, [userId])
    return rows.map(memorySummaryDto)
  }
  async getMemory(userId: number, memoryId: string) {
    const [rows] = await this.pool.execute<MemoryRow[]>(`${memorySelect} WHERE l.id=? AND (l.owner_user_id=? OR (l.owner_user_id IS NULL AND s.scope='platform')) LIMIT 1`, [memoryId, userId])
    return rows[0] ? memoryDetailDto(rows[0]) : null
  }
  async listMemoryUpdates(userId: number, memoryId: string) {
    const [rows] = await this.pool.execute<MemoryUpdateRow[]>(`SELECT ${memoryUpdateColumns} FROM strategy_memory_pending_updates_v4 u INNER JOIN strategy_memory_libraries_v4 l ON l.id=u.library_id INNER JOIN strategies s ON s.id=l.strategy_id WHERE u.library_id=? AND (l.owner_user_id=? OR (l.owner_user_id IS NULL AND s.scope='platform')) ORDER BY u.created_at_utc DESC,u.id`, [memoryId, userId])
    return rows.map(memoryUpdateDto)
  }

  async decideMemoryUpdate(input: Parameters<ReviewRepository['decideMemoryUpdate']>[0]) {
    await transaction(this.pool, async connection => {
      const [rows] = await connection.execute<MemoryDecisionRow[]>(`SELECT ${memoryUpdateColumns},l.owner_user_id,l.revision library_revision,r.version_number current_version_number,r.content_text,r.content_json FROM strategy_memory_pending_updates_v4 u INNER JOIN strategy_memory_libraries_v4 l ON l.id=u.library_id LEFT JOIN strategy_memory_library_revisions_v4 r ON r.id=l.current_revision_id AND r.library_id=l.id WHERE u.id=? FOR UPDATE`, [input.updateId])
      const row = rows[0]
      if (!row || row.owner_user_id !== input.userId) throw new ReviewError('strategy_memory_update_not_found', 404)
      const expectedStatus = input.decision === 'revoke' ? 'merged' : 'awaiting_confirmation'
      if (Number(row.revision) !== input.expectedRevision || row.status !== expectedStatus) throw new ReviewError('strategy_memory_update_revision_conflict', 412)
      if (input.decision === 'reject') {
        await connection.execute(`UPDATE strategy_memory_pending_updates_v4 SET status='rejected',decided_by_user_id=?,decided_at_utc=?,updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [input.userId, input.now, input.now, input.updateId, input.expectedRevision])
      } else if (input.decision === 'accept') {
        if (row.update_kind === 'long_term_candidate') {
          const [support] = await connection.execute<(RowDataPacket & { support_count: number })[]>(`SELECT COUNT(DISTINCT u.source_review_case_id) support_count FROM strategy_memory_pending_updates_v4 u INNER JOIN review_cases_v4 c ON c.id=u.source_review_case_id WHERE u.library_id=? AND u.update_kind='long_term_candidate' AND u.proposal_key=? AND u.status IN ('collecting_evidence','awaiting_confirmation') AND c.status='confirmed'`, [row.library_id, row.proposal_key])
          if (Number(support[0]?.support_count ?? 0) < 3) throw new ReviewError('strategy_memory_long_term_support_insufficient', 409)
        }
        const proposal = parse<Record<string, unknown>>(row.proposal_json)
        const addition = typeof proposal.content === 'string' ? proposal.content.trim() : ''
        if (!addition) throw new ReviewError('strategy_memory_update_content_invalid', 409)
        const libraryRevision = Number(row.library_revision)
        if (libraryRevision !== Number(row.expected_library_revision)) throw new ReviewError('strategy_memory_library_revision_conflict', 412)
        const document = memoryDocument(row.content_json, row.content_text)
        const conflicts = parse<Array<{ prior_update_id?: unknown }>>(row.conflict_json)
        const replacedUpdateIds = new Set(conflicts.map(conflict => typeof conflict.prior_update_id === 'string' ? conflict.prior_update_id : '').filter(Boolean))
        document.blocks = document.blocks.filter(block => !block.memory_update_id || !replacedUpdateIds.has(block.memory_update_id))
        document.blocks.push({ kind: 'review_memory', memory_update_id: input.updateId, content: addition })
        const content = renderMemoryDocument(document)
        const revisionId = randomUUID(); const version = Number(row.current_version_number ?? 0) + 1; const hash = sha256(content)
        await connection.execute(`INSERT INTO strategy_memory_library_revisions_v4 (id,library_id,version_number,content_text,content_json,content_sha256,source_kind,source_metadata_json,created_by_user_id,created_at_utc) VALUES (?,?,?,?,?,?,'review_merge',?,?,?)`, [revisionId, row.library_id, version, content, JSON.stringify(document), hash, JSON.stringify({ memory_update_id: input.updateId, source_review_version_id: row.source_review_version_id }), input.userId, input.now])
        const [library] = await connection.execute<ResultSetHeader>(`UPDATE strategy_memory_libraries_v4 SET current_revision_id=?,revision=revision+1,updated_at_utc=? WHERE id=? AND revision=?`, [revisionId, input.now, row.library_id, libraryRevision])
        if (library.affectedRows !== 1) throw new ReviewError('strategy_memory_library_revision_conflict', 412)
        await connection.execute(`UPDATE strategy_memory_pending_updates_v4 SET status='merged',decided_by_user_id=?,decided_at_utc=?,merged_revision_id=?,updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [input.userId, input.now, revisionId, input.now, input.updateId, input.expectedRevision])
        if (replacedUpdateIds.size > 0) {
          const placeholders = [...replacedUpdateIds].map(() => '?').join(',')
          await connection.execute(`UPDATE strategy_memory_pending_updates_v4 SET status='superseded',updated_at_utc=?,revision=revision+1 WHERE library_id=? AND id IN (${placeholders}) AND status='merged'`, [input.now, row.library_id, ...replacedUpdateIds])
        }
        if (row.update_kind === 'long_term_candidate') await connection.execute(`UPDATE strategy_memory_pending_updates_v4 SET status='superseded',updated_at_utc=?,revision=revision+1 WHERE library_id=? AND update_kind='long_term_candidate' AND proposal_key=? AND status='collecting_evidence'`, [input.now, row.library_id, row.proposal_key])
        await rebasePendingUpdates(connection, row.library_id, input.updateId, libraryRevision + 1, input.now)
      } else {
        const libraryRevision = Number(row.library_revision)
        const document = memoryDocument(row.content_json, row.content_text)
        const blocks = document.blocks.filter(block => block.memory_update_id !== input.updateId)
        if (blocks.length === document.blocks.length) throw new ReviewError('strategy_memory_revoke_block_not_found', 409)
        const revokedDocument: MemoryDocument = { schema_version: 'strategy_memory.v4.1', blocks }
        const content = renderMemoryDocument(revokedDocument)
        const revisionId = randomUUID(); const version = Number(row.current_version_number ?? 0) + 1; const hash = sha256(content)
        await connection.execute(`INSERT INTO strategy_memory_library_revisions_v4 (id,library_id,version_number,content_text,content_json,content_sha256,source_kind,source_metadata_json,created_by_user_id,created_at_utc) VALUES (?,?,?,?,?,?,'revoke',?,?,?)`, [revisionId, row.library_id, version, content, JSON.stringify(revokedDocument), hash, JSON.stringify({ revoked_memory_update_id: input.updateId, prior_merged_revision_id: row.merged_revision_id }), input.userId, input.now])
        const [library] = await connection.execute<ResultSetHeader>(`UPDATE strategy_memory_libraries_v4 SET current_revision_id=?,revision=revision+1,updated_at_utc=? WHERE id=? AND revision=?`, [revisionId, input.now, row.library_id, libraryRevision])
        if (library.affectedRows !== 1) throw new ReviewError('strategy_memory_library_revision_conflict', 412)
        await connection.execute(`UPDATE strategy_memory_pending_updates_v4 SET status='superseded',updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [input.now, input.updateId, input.expectedRevision])
        await rebasePendingUpdates(connection, row.library_id, input.updateId, libraryRevision + 1, input.now)
      }
      const [pendingRows] = await connection.execute<(RowDataPacket & { pending_count: number })[]>(`SELECT COUNT(*) pending_count FROM strategy_memory_pending_updates_v4 WHERE library_id=? AND status='awaiting_confirmation'`, [row.library_id])
      const resultingLibraryRevision = input.decision === 'reject' ? Number(row.library_revision) : Number(row.library_revision) + 1
      await outbox(connection, 'strategy_memory', row.library_id, 'strategy.memory.changed', { strategy_memory_id: row.library_id, status: 'active', pending_count: Number(pendingRows[0]?.pending_count ?? 0), revision: String(resultingLibraryRevision) })
    })
    const [rows] = await this.pool.execute<MemoryUpdateRow[]>(`SELECT ${memoryUpdateColumns} FROM strategy_memory_pending_updates_v4 u WHERE u.id=? LIMIT 1`, [input.updateId])
    if (!rows[0]) throw new ReviewError('strategy_memory_update_not_found', 404)
    return memoryUpdateDto(rows[0])
  }

  async claimJob(jobId: string, workerId: string, claimedAt: string, leaseExpiresAt: string) {
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<ReviewJobContextRow[]>(`${reviewJobContextSelect} WHERE j.id=? FOR UPDATE`, [jobId])
      const row = rows[0]
      if (!row || !['queued', 'retry_wait', 'running'].includes(row.status)) return null
      if (row.status === 'running' && row.lease_expires_at_utc && row.lease_expires_at_utc.getTime() > new Date(claimedAt).getTime()) return null
      if (row.input_sha256 !== row.evidence_sha256) throw new ReviewError('review_job_evidence_hash_mismatch', 409)
      if (row.status === 'running') {
        await connection.execute(`UPDATE review_model_attempts_v4 SET status='timed_out',error_code='review_attempt_lease_expired',completed_at_utc=? WHERE review_job_id=? AND status='running'`, [claimedAt, jobId])
      }
      const fencingToken = Number(row.fencing_token) + 1
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE review_jobs_v4 SET status='running',current_stage='waiting_model',lease_owner=?,lease_expires_at_utc=?,fencing_token=?,attempt_count=attempt_count+1,progress_percent=25,updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1 WHERE id=? AND fencing_token=?`, [workerId, leaseExpiresAt, fencingToken, jobId, row.fencing_token])
      if (updated.affectedRows !== 1) return null
      await connection.execute(`UPDATE review_cases_v4 SET status='running',updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1 WHERE id=? AND status IN ('queued','running','failed')`, [row.case_id])
      await jobEvent(connection, jobId, 'review_started', row.status, 'running', { fencing_token: fencingToken }, new Date().toISOString())
      await outbox(connection, 'review_case', row.case_id, 'review.case.changed', { review_case_id: row.case_id, status: 'running', current_version_id: row.current_version_id, revision: String(Number(row.case_revision) + 1) })
      return {
        jobId: row.job_id, caseId: row.case_id, userId: Number(row.user_id), tradingAccountId: String(row.trading_account_id), kind: row.kind,
        generation: Number(row.generation), evidenceRevision: Number(row.evidence_revision), evidenceHash: row.evidence_sha256,
        evidence: parse<Record<string, unknown>>(row.evidence_json), allowedEvidenceRefs: parseList(row.source_refs), strategyId: row.strategy_id,
        allowedStrategyIds: [row.analysis_strategy_id, row.trader_strategy_id].filter((value): value is string => Boolean(value)),
        analysisPrompt: row.analysis_prompt, traderPrompt: row.trader_prompt, fencingToken, workerId, nextAttemptNumber: Number(row.next_attempt_number),
      }
    })
  }

  async startModelAttempt(input: Parameters<ReviewWorkerRepository['startModelAttempt']>[0]) {
    await transaction(this.pool, async connection => {
      await assertClaim(connection, input.claim)
      await connection.execute(`INSERT INTO review_model_attempts_v4 (id,review_job_id,attempt_number,model_profile_id,provider,model,status,started_at_utc) VALUES (?,?,?,?,?,?,'running',?)`, [input.attemptId, input.claim.jobId, input.attemptNumber, input.profileId, input.provider, input.model, input.now])
      await connection.execute(`UPDATE review_jobs_v4 SET model_profile_id=?,current_stage='waiting_model',updated_at_utc=?,revision=revision+1 WHERE id=? AND fencing_token=?`, [input.profileId, input.now, input.claim.jobId, input.claim.fencingToken])
    })
  }

  async failJob(input: Parameters<ReviewWorkerRepository['failJob']>[0]) {
    await transaction(this.pool, async connection => {
      await assertClaim(connection, input.claim)
      await failClaimedJob(connection, input.claim, input.errorCode, input.now)
    })
  }

  async failModelAttempt(input: Parameters<ReviewWorkerRepository['failModelAttempt']>[0]) {
    await transaction(this.pool, async connection => {
      await assertClaim(connection, input.claim)
      const [attempt] = await connection.execute<ResultSetHeader>(`UPDATE review_model_attempts_v4 SET status=?,error_code=?,completed_at_utc=? WHERE id=? AND review_job_id=? AND status='running'`, [input.status, input.errorCode, input.now, input.attemptId, input.claim.jobId])
      if (attempt.affectedRows !== 1) throw new ReviewError('review_model_attempt_not_running', 409)
      if (!input.final) return
      await failClaimedJob(connection, input.claim, input.errorCode, input.now)
    })
  }

  async completeJob(input: Parameters<ReviewWorkerRepository['completeJob']>[0]) {
    return transaction(this.pool, async connection => {
      await assertClaim(connection, input.claim)
      const [attempt] = await connection.execute<ResultSetHeader>(`UPDATE review_model_attempts_v4 SET status='succeeded',response_sha256=?,usage_json=?,completed_at_utc=? WHERE id=? AND review_job_id=? AND status='running'`, [input.responseHash, input.usage ? JSON.stringify(input.usage) : null, input.now, input.attemptId, input.claim.jobId])
      if (attempt.affectedRows !== 1) throw new ReviewError('review_model_attempt_not_running', 409)
      const [numbers] = await connection.execute<(RowDataPacket & { version_number: number })[]>(`SELECT COALESCE(MAX(version_number),0)+1 version_number FROM review_versions_v4 WHERE review_case_id=? FOR UPDATE`, [input.claim.caseId])
      const versionId = randomUUID(); const versionNumber = Number(numbers[0]?.version_number ?? 1)
      const compact = { ...input.content, fullAnalysisText: undefined }; const contentJson = JSON.stringify(compact); const payloadHash = sha256({ compact, fullAnalysisText: input.content.fullAnalysisText })
      await connection.execute(`INSERT INTO review_versions_v4 (id,review_case_id,version_number,source_job_id,author_kind,created_by_user_id,conclusion_code,net_profit,trade_count,win_rate_percent,profit_factor,content_sha256,created_at_utc) VALUES (?,?,?,?,'ai',NULL,?,?,?,?,?,?,?)`, [versionId, input.claim.caseId, versionNumber, input.claim.jobId, input.content.conclusion, input.content.metrics.netProfit, input.content.metrics.tradeCount, input.content.metrics.winRatePercent, input.content.metrics.profitFactor, payloadHash, input.now])
      await connection.execute(`INSERT INTO review_version_payloads_v4 (review_version_id,content_json,full_analysis_text,payload_sha256,payload_bytes) VALUES (?,?,?,?,?)`, [versionId, contentJson, input.content.fullAnalysisText, payloadHash, Buffer.byteLength(contentJson) + Buffer.byteLength(input.content.fullAnalysisText)])
      await connection.execute(`UPDATE review_jobs_v4 SET status='succeeded',current_stage='completed',progress_percent=100,lease_owner=NULL,lease_expires_at_utc=NULL,completed_at_utc=?,updated_at_utc=?,revision=revision+1 WHERE id=? AND fencing_token=?`, [input.now, input.now, input.claim.jobId, input.claim.fencingToken])
      const [caseRows] = await connection.execute<(RowDataPacket & { revision: number })[]>(`SELECT revision FROM review_cases_v4 WHERE id=? FOR UPDATE`, [input.claim.caseId])
      const revision = Number(caseRows[0]?.revision ?? 0) + 1
      await connection.execute(`UPDATE review_cases_v4 SET status='awaiting_confirmation',current_version_id=?,confirmed_version_id=NULL,confirmed_by_user_id=NULL,confirmed_at_utc=NULL,return_reason=NULL,updated_at_utc=?,revision=? WHERE id=?`, [versionId, input.now, revision, input.claim.caseId])
      await connection.execute(`INSERT INTO review_user_states_v4 (review_case_id,user_id,seen_version_id,seen_at_utc,revision) VALUES (?,?,NULL,NULL,1) ON DUPLICATE KEY UPDATE revision=revision`, [input.claim.caseId, input.claim.userId])
      await jobEvent(connection, input.claim.jobId, 'review_succeeded', 'running', 'succeeded', { version_id: versionId }, input.now)
      await outbox(connection, 'review_case', input.claim.caseId, 'review.case.changed', { review_case_id: input.claim.caseId, status: 'awaiting_confirmation', current_version_id: versionId, revision: String(revision) })
      return { versionId }
    })
  }
}

const reviewJobContextSelect = `SELECT j.id job_id,c.id case_id,c.user_id,CAST(c.trading_account_id AS CHAR) trading_account_id,c.kind,j.generation,j.evidence_revision,j.input_sha256,e.evidence_sha256,e.evidence_json,CAST(COALESCE(c.analysis_strategy_id,c.trader_strategy_id) AS CHAR) strategy_id,CAST(c.analysis_strategy_id AS CHAR) analysis_strategy_id,CAST(c.trader_strategy_id AS CHAR) trader_strategy_id,sa.prompt_text analysis_prompt,st.prompt_text trader_prompt,j.status,j.lease_expires_at_utc,j.fencing_token,c.revision case_revision,c.current_version_id,(SELECT COALESCE(MAX(a.attempt_number),0)+1 FROM review_model_attempts_v4 a WHERE a.review_job_id=j.id) next_attempt_number,(SELECT JSON_ARRAYAGG(CONCAT(rs.source_kind,':',rs.source_id)) FROM review_case_sources_v4 rs WHERE rs.review_case_id=c.id) source_refs FROM review_jobs_v4 j INNER JOIN review_cases_v4 c ON c.id=j.review_case_id INNER JOIN review_evidence_payloads_v4 e ON e.review_case_id=c.id AND e.evidence_revision=j.evidence_revision LEFT JOIN strategy_versions sa ON sa.id=c.analysis_strategy_version_id AND sa.strategy_id=c.analysis_strategy_id LEFT JOIN strategy_versions st ON st.id=c.trader_strategy_version_id AND st.strategy_id=c.trader_strategy_id`

async function assertClaim(connection: PoolConnection, claim: ReviewJobClaim) {
  const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM review_jobs_v4 WHERE id=? AND status='running' AND lease_owner=? AND fencing_token=? AND lease_expires_at_utc>UTC_TIMESTAMP(3) FOR UPDATE`, [claim.jobId, claim.workerId, claim.fencingToken])
  if (!rows[0]) throw new ReviewError('review_job_claim_stale', 409)
}

async function failClaimedJob(connection: PoolConnection, claim: ReviewJobClaim, errorCode: string, now: string) {
  await connection.execute(`UPDATE review_jobs_v4 SET status='failed',current_stage='failed',last_error_code=?,progress_percent=100,lease_owner=NULL,lease_expires_at_utc=NULL,completed_at_utc=?,updated_at_utc=?,revision=revision+1 WHERE id=? AND fencing_token=?`, [errorCode, now, now, claim.jobId, claim.fencingToken])
  const [caseRows] = await connection.execute<(RowDataPacket & { revision: number; current_version_id: string | null })[]>(`SELECT revision,current_version_id FROM review_cases_v4 WHERE id=? FOR UPDATE`, [claim.caseId])
  const revision = Number(caseRows[0]?.revision ?? 0) + 1
  await connection.execute(`UPDATE review_cases_v4 SET status='failed',updated_at_utc=?,revision=? WHERE id=?`, [now, revision, claim.caseId])
  await jobEvent(connection, claim.jobId, 'review_failed', 'running', 'failed', { error_code: errorCode }, now)
  await outbox(connection, 'review_case', claim.caseId, 'review.case.changed', { review_case_id: claim.caseId, status: 'failed', current_version_id: caseRows[0]?.current_version_id ?? null, revision: String(revision) })
}

async function assertCaseEvidenceRefs(connection: PoolConnection, caseId: string, refs: string[]) {
  const [rows] = await connection.execute<(RowDataPacket & { evidence_ref: string })[]>(`SELECT CONCAT(source_kind,':',source_id) evidence_ref FROM review_case_sources_v4 WHERE review_case_id=?`, [caseId])
  const allowed = new Set(rows.map(row => row.evidence_ref))
  if (refs.some(ref => !allowed.has(ref))) throw new ReviewError('review_evidence_reference_invalid', 422)
}

async function loadDetail(pool: Pool, userId: number, caseId: string): Promise<ReviewCaseDetail | null> {
  const [cases] = await pool.execute<CaseRow[]>(`${caseSelect} WHERE c.user_id=? AND c.id=? LIMIT 1`, [userId, caseId]); const row = cases[0]
  if (!row) return null
  const [versions, sources, jobs] = await Promise.all([
    row.current_version_id ? pool.execute<VersionRow[]>(`SELECT v.id,v.review_case_id,v.version_number,v.author_kind,v.conclusion_code,p.content_json,p.full_analysis_text,v.created_at_utc FROM review_versions_v4 v INNER JOIN review_version_payloads_v4 p ON p.review_version_id=v.id WHERE v.id=? AND v.review_case_id=? LIMIT 1`, [row.current_version_id, caseId]).then(value => value[0]) : Promise.resolve([] as VersionRow[]),
    pool.execute<SourceRow[]>('SELECT source_kind,source_id,relation_kind,source_sha256 FROM review_case_sources_v4 WHERE review_case_id=? ORDER BY id', [caseId]).then(value => value[0]),
    pool.execute<JobRow[]>('SELECT id,generation,mode,status,progress_percent,current_stage,last_error_code,updated_at_utc FROM review_jobs_v4 WHERE review_case_id=? ORDER BY generation DESC LIMIT 1', [caseId]).then(value => value[0]),
  ])
  return { summary: caseDto(row), currentVersion: versions[0] ? versionDto(versions[0]) : null, sources: sources.map(sourceDto), currentJob: jobs[0] ? jobDto(jobs[0]) : null, returnReason: row.return_reason }
}

async function lockCase(connection: PoolConnection, userId: number, caseId: string) {
  const [rows] = await connection.execute<CaseLockRow[]>('SELECT revision,status,evidence_status,evidence_sha256,evidence_revision,current_version_id FROM review_cases_v4 WHERE id=? AND user_id=? FOR UPDATE', [caseId, userId])
  if (!rows[0]) throw new ReviewError('review_case_not_found', 404)
  return rows[0]
}

async function createPendingMemoryUpdate(connection: PoolConnection, input: Parameters<ReviewRepository['confirmVersion']>[0], candidate: ReviewContent['memoryCandidates'][number]) {
  const [strategies] = await connection.execute<(RowDataPacket & { owner_user_id: number | null; name: string })[]>(`SELECT owner_user_id,name FROM strategies WHERE id=? FOR SHARE`, [candidate.strategyId])
  const strategy = strategies[0]
  if (!strategy || strategy.owner_user_id !== input.userId) return
  const [libraries] = await connection.execute<(RowDataPacket & { id: string; revision: number })[]>('SELECT id,revision FROM strategy_memory_libraries_v4 WHERE strategy_id=? FOR UPDATE', [candidate.strategyId])
  let library = libraries[0]
  if (!library) {
    const libraryId = randomUUID()
    await connection.execute(`INSERT INTO strategy_memory_libraries_v4 (id,strategy_id,owner_user_id,mode,status,current_revision_id,max_context_tokens,revision,created_at_utc,updated_at_utc) VALUES (?,?,?,'shadow','active',NULL,800,1,?,?)`, [libraryId, candidate.strategyId, input.userId, input.now, input.now])
    library = { id: libraryId, revision: 1 } as RowDataPacket & { id: string; revision: number }
  }
  const updateId = randomUUID(); const proposalKey = sha256(`${candidate.strategyId}:${candidate.memoryKey}`)
  const proposal = { memory_key: candidate.memoryKey, title: candidate.title, content: candidate.content, evidence_refs: candidate.evidenceRefs }
  const [merged] = await connection.execute<(RowDataPacket & { id: string; proposal_json: string | Record<string, unknown> })[]>(`SELECT id,proposal_json FROM strategy_memory_pending_updates_v4 WHERE library_id=? AND proposal_key=? AND status='merged' ORDER BY decided_at_utc DESC,id DESC LIMIT 1`, [library.id, proposalKey])
  const prior = merged[0] ? parse<Record<string, unknown>>(merged[0].proposal_json) : null
  const conflicts = prior && prior.content !== candidate.content ? [{ type: 'same_key_content_changed', prior_update_id: merged[0]!.id, memory_key: candidate.memoryKey }] : []
  let status: StrategyMemoryUpdate['status'] = 'awaiting_confirmation'
  if (candidate.updateKind === 'long_term_candidate') {
    const [support] = await connection.execute<(RowDataPacket & { support_count: number })[]>(`SELECT COUNT(DISTINCT u.source_review_case_id) support_count FROM strategy_memory_pending_updates_v4 u INNER JOIN review_cases_v4 c ON c.id=u.source_review_case_id WHERE u.library_id=? AND u.update_kind='long_term_candidate' AND u.proposal_key=? AND u.status IN ('collecting_evidence','awaiting_confirmation') AND c.status='confirmed'`, [library.id, proposalKey])
    status = Number(support[0]?.support_count ?? 0) >= 2 ? 'awaiting_confirmation' : 'collecting_evidence'
  }
  await connection.execute(`INSERT INTO strategy_memory_pending_updates_v4 (id,library_id,source_review_case_id,source_review_version_id,update_kind,proposal_key,status,expected_library_revision,proposal_json,diff_preview_text,conflict_json,created_at_utc,updated_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON DUPLICATE KEY UPDATE id=id`, [updateId, library.id, input.caseId, input.versionId, candidate.updateKind, proposalKey, status, library.revision, JSON.stringify(proposal), `+ ${candidate.content}`, JSON.stringify(conflicts), input.now, input.now])
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}
async function jobEvent(connection: PoolConnection, jobId: string, event: string, from: string | null, to: string, metadata: object, now: string) { await connection.execute(`INSERT INTO review_job_events_v4 (review_job_id,event_type,from_status,to_status,metadata_json,occurred_at_utc) VALUES (?,?,?,?,?,?)`, [jobId, event, from, to, JSON.stringify(metadata), now]) }
async function outbox(connection: PoolConnection, aggregate: string, aggregateId: string, type: string, payload: object) { await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(), aggregate, aggregateId, type, JSON.stringify(payload)]) }

function caseDto(row: CaseRow): ReviewCaseSummary { return { id: row.id, kind: row.kind, userId: Number(row.user_id), tradingAccountId: String(row.trading_account_id), accountLabel: row.account_label, standardSymbol: row.standard_symbol, subscriptionId: row.subscription_id, subscriptionRevision: row.subscription_revision === null ? null : Number(row.subscription_revision), analysisStrategyId: row.analysis_strategy_id, analysisStrategyName: row.analysis_strategy_name, traderStrategyId: row.trader_strategy_id, traderStrategyName: row.trader_strategy_name, terminalPeriodStart: utc(row.terminal_period_start_utc), terminalPeriodEnd: utc(row.terminal_period_end_utc), terminalTimezoneOffsetMinutes: Number(row.terminal_timezone_offset_minutes), status: row.status, evidenceStatus: row.evidence_status, evidenceRevision: Number(row.evidence_revision), evidenceHash: row.evidence_sha256, currentVersionId: row.current_version_id, confirmedVersionId: row.confirmed_version_id, updatedAt: utc(row.updated_at_utc), revision: Number(row.revision) } }
function versionDto(row: VersionRow): ReviewVersion { const content = reviewContent(row); return { id: row.id, caseId: row.review_case_id, versionNumber: Number(row.version_number), authorKind: row.author_kind, conclusion: row.conclusion_code, content, createdAt: utc(row.created_at_utc) } }
function reviewContent(row: VersionRow): ReviewContent { const content = parse<Omit<ReviewContent, 'fullAnalysisText'>>(row.content_json); return { ...content, fullAnalysisText: row.full_analysis_text } }
function sourceDto(row: SourceRow): ReviewSource { return { kind: row.source_kind, sourceId: row.source_id, relation: row.relation_kind, evidenceHash: row.source_sha256 } }
function jobDto(row: JobRow): ReviewJobSummary { return { id: row.id, generation: Number(row.generation), mode: row.mode, status: row.status, progressPercent: Number(row.progress_percent), currentStage: row.current_stage, lastErrorCode: row.last_error_code, updatedAt: utc(row.updated_at_utc) } }
function candidateDto(row: CandidateRow): ManualReviewCandidate { return { id: row.id, tradingAccountId: String(row.trading_account_id), accountLabel: row.account_label, ticket: row.ticket, positionId: row.position_id, symbol: row.symbol, side: row.side, volume: String(row.volume), openedAt: utc(row.opened_at_utc), closedAt: utc(row.closed_at_utc), netProfit: String(row.net_profit), terminalTimezoneOffsetMinutes: Number(row.terminal_timezone_offset_minutes), sourceClassification: row.source_classification, eligibilityStatus: row.eligibility_status, selectionToken: `${row.id}.${row.revision}.${row.evidence_sha256}`, selectionExpiresAt: utc(row.selection_expires_at_utc), revision: Number(row.revision) } }
function memorySummaryDto(row: MemoryRow): StrategyMemorySummary { return { id: row.id, strategyId: row.strategy_id, strategyName: row.strategy_name, strategyKind: row.strategy_kind, ownerUserId: row.owner_user_id === null ? null : Number(row.owner_user_id), mode: row.mode, status: row.status, currentVersionNumber: Number(row.current_version_number ?? 0), pendingCount: Number(row.pending_count), updatedAt: utc(row.updated_at_utc), revision: Number(row.revision) } }
function memoryDetailDto(row: MemoryRow): StrategyMemoryDetail { return { ...memorySummaryDto(row), currentRevisionId: row.current_revision_id, contentText: row.content_text ?? '', contentHash: row.content_sha256, maxContextTokens: Number(row.max_context_tokens) } }
function memoryUpdateDto(row: MemoryUpdateRow): StrategyMemoryUpdate {
  const proposal = parse<{ memory_key: string; title: string; content: string; evidence_refs: string[] }>(row.proposal_json)
  const conflicts = parse<Array<{ type: 'same_key_content_changed'; prior_update_id: string; memory_key: string }>>(row.conflict_json)
  return {
    id: row.id, libraryId: row.library_id, sourceReviewCaseId: row.source_review_case_id, sourceReviewVersionId: row.source_review_version_id,
    updateKind: row.update_kind, status: row.status, expectedLibraryRevision: Number(row.expected_library_revision),
    proposal: { memoryKey: proposal.memory_key, title: proposal.title, content: proposal.content, evidenceRefs: proposal.evidence_refs },
    diffPreviewText: row.diff_preview_text,
    conflicts: conflicts.map(conflict => ({ type: conflict.type, priorUpdateId: conflict.prior_update_id, memoryKey: conflict.memory_key })),
    createdAt: utc(row.created_at_utc), revision: Number(row.revision),
  }
}
function parse<T = Record<string, unknown>>(value: string | object): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T }
function parseList(value: string | string[] | null): string[] { if (Array.isArray(value)) return value; if (!value) return []; try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : [] } catch { return [] } }
function utc(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString() }
function sha256(value: unknown) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex') }
function memoryDocument(value: string | MemoryDocument | null, contentText: string | null): MemoryDocument {
  const parsed = value ? parse<Partial<MemoryDocument>>(value) : null
  if (parsed?.schema_version === 'strategy_memory.v4.1' && Array.isArray(parsed.blocks)) return { schema_version: 'strategy_memory.v4.1', blocks: parsed.blocks.filter(block => block && typeof block.content === 'string') as MemoryBlock[] }
  const legacy = String(contentText ?? '').trim()
  return { schema_version: 'strategy_memory.v4.1', blocks: legacy ? [{ kind: 'legacy_snapshot', content: legacy }] : [] }
}
function renderMemoryDocument(value: MemoryDocument) { return value.blocks.map(block => block.content.trim()).filter(Boolean).join('\n\n') }
async function rebasePendingUpdates(connection: PoolConnection, libraryId: string, excludedUpdateId: string, expectedLibraryRevision: number, now: string) {
  await connection.execute(`UPDATE strategy_memory_pending_updates_v4 SET expected_library_revision=?,updated_at_utc=?,revision=revision+1 WHERE library_id=? AND id<>? AND status IN ('collecting_evidence','awaiting_confirmation')`, [expectedLibraryRevision, now, libraryId, excludedUpdateId])
}
