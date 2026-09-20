import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { SystemTradeCaseWriter } from '../application/system-trade-case.js'
import { reviewEvidenceHash } from './review-evidence-integrity.js'
import { reviewSqlTime } from './review-sql-time.js'

/** Caller must hold the source record lock and roll back the whole collection transaction on error. */
export function createMysqlSystemTradeCaseWriter(connection: PoolConnection): SystemTradeCaseWriter {
  return { async create(input) {
    const { trade, source } = structuredClone(input), e = trade.evidence
    if (trade.status !== 'ready_as_of' || e.source !== 'system' || source.status !== 'proven'
      || !source.proofs.length || !Number.isSafeInteger(e.revision) || e.revision < 1
      || Date.parse(e.closedAt) <= Date.parse(e.openedAt)) throw Error('system_review_evidence_invalid')
    const scopeKey = `system:${e.accountId}:${e.recordId}`
    // Exclude discovery task/cutoff/revision: a second history task must not create another review.
    const sourceHash = reviewEvidenceHash({ recordHash: e.evidenceHash, strategyId: source.strategyId,
      strategyVersionId: source.strategyVersionId, proofs: [...source.proofs].sort((a, b) => a.dealTicket.localeCompare(b.dealTicket)) })
    const [existing] = await connection.execute<RowDataPacket[]>(`SELECT c.id,c.trader_strategy_id,c.trader_strategy_version_id,s.source_sha256
      FROM review_cases_v4 c LEFT JOIN review_case_sources_v4 s ON s.review_case_id=c.id
        AND s.source_kind='terminal_trade' AND s.source_id=? AND s.relation_kind='direct'
      WHERE c.user_id=? AND c.kind='trade' AND c.scope_key=? FOR UPDATE`, [e.recordId, e.userId, scopeKey])
    if (existing.length) {
      const row = existing[0]!
      if (existing.length !== 1 || row.source_sha256 !== sourceHash || String(row.trader_strategy_id) !== source.strategyId
        || String(row.trader_strategy_version_id) !== source.strategyVersionId) throw Error('system_review_source_changed')
      return { status: 'unchanged', caseId: String(row.id) }
    }
    const [versions] = await connection.execute<RowDataPacket[]>(`SELECT v.id FROM strategy_versions v
      INNER JOIN strategies s ON s.id=v.strategy_id WHERE v.id=? AND v.strategy_id=? AND s.kind='trader' LIMIT 1 FOR SHARE`,
    [source.strategyVersionId, source.strategyId])
    if (!versions.length) throw Error('system_review_strategy_version_unavailable')
    const frozen = { schema_version: 'review-evidence.v4.3', source: 'system_trade', trade, execution: source,
      contextCoverage: { terminalTrade: 'complete_as_of', executionLineage: 'exact', analysisContent: 'not_captured', riskContent: 'not_captured' } }
    const json = JSON.stringify(frozen), hash = reviewEvidenceHash(frozen), id = randomUUID()
    await connection.execute(`INSERT INTO review_cases_v4
      (id,user_id,trading_account_id,kind,scope_key,standard_symbol,trader_strategy_id,trader_strategy_version_id,
       terminal_period_start_utc,terminal_period_end_utc,terminal_timezone_offset_minutes,status,evidence_status,
       evidence_revision,evidence_sha256,created_at_utc,updated_at_utc,revision)
      VALUES (?,?,?,'trade',?,?,?,?,?,?,?,'awaiting_evidence','incomplete',1,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),1)`,
    [id,e.userId,e.accountId,scopeKey,e.projection.symbol,source.strategyId,source.strategyVersionId,
      reviewSqlTime(e.openedAt),reviewSqlTime(e.closedAt),e.terminalTimezoneOffsetMinutes,hash])
    await connection.execute(`INSERT INTO review_evidence_payloads_v4
      (review_case_id,evidence_revision,evidence_json,evidence_sha256,payload_bytes,created_at_utc)
      VALUES (?,1,?,?,?,UTC_TIMESTAMP(3))`, [id,json,hash,Buffer.byteLength(json)])
    await connection.execute(`INSERT INTO review_case_sources_v4
      (review_case_id,source_kind,source_id,relation_kind,source_sha256,source_metadata_json,created_at_utc)
      VALUES (?,'terminal_trade',?,'direct',?,?,UTC_TIMESTAMP(3))`, [id,e.recordId,sourceHash,
      JSON.stringify({ recordHash: e.evidenceHash, recordRevision: e.revision, positionId: e.projection.positionId })])
    // The model job is deliberately deferred until analysis/risk context has been captured.
    await connection.execute(`INSERT INTO outbox_events
      (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
      VALUES (?,'review_case',?,'review.case.changed',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(),id,
      JSON.stringify({ review_case_id: id, status: 'awaiting_evidence', current_version_id: null, revision: '1' })])
    return { status: 'created', caseId: id }
  } }
}
