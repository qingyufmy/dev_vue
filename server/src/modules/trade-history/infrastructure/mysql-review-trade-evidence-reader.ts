import { createHash } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ReviewTradeEvidenceReader, ReviewTradeEvidenceResult } from '../application/review-trade-evidence-reader.js'
import { readTradeCostEvidence } from '../domain/trade-cost-evidence.js'
import { TradeHistoryError } from '../domain/trade-history.js'
import { decodeTerminalHistoryPage, type TerminalDealFact } from '../domain/terminal-history-projection.js'
import { provenHistoryRecordSql } from './trade-history-ownership-sql.js'
import { reconstructReviewTrade } from '../domain/review-trade-lifecycle.js'

interface RecordRow extends RowDataPacket {
  id: string; account_id: string; user_id: number; ownership_interval_id: string; revision: number
  platform: 'mt4' | 'mt5'; source_classification: 'system' | 'manual'; status: string; attribution_status: string
  currency_evidence: string; account_currency: string | null; evidence_sha256: string
  opened_at: string; closed_at: string; terminal_timezone_offset_minutes: number
  position_id: string | null
}
interface FactRow extends RowDataPacket { id: string | null; deal_ticket: string; evidence_sha256: string; evidence_json: string | object }
const unresolved = (reason: Extract<ReviewTradeEvidenceResult, { status: 'unresolved' }>['reason']): ReviewTradeEvidenceResult => ({ status: 'unresolved', reason })

export function createMysqlReviewTradeEvidenceReader(connection: Pick<PoolConnection, 'execute'>): ReviewTradeEvidenceReader {
  return createReader(connection)
}

/** Admission of unclassified records is private to exact system-source reconciliation. */
export function createMysqlSystemReviewTradeEvidenceReader(connection: Pick<PoolConnection, 'execute'>,
  verify: (facts: TerminalDealFact[]) => Promise<boolean>): ReviewTradeEvidenceReader {
  return createReader(connection, verify)
}

function createReader(connection: Pick<PoolConnection, 'execute'>,
  verifySystem?: (facts: TerminalDealFact[]) => Promise<boolean>): ReviewTradeEvidenceReader {
  return { async read(input) {
    if (!Number.isSafeInteger(input.userId) || input.userId < 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || typeof input.recordId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(input.recordId)) throw new TradeHistoryError('review_trade_evidence_scope_invalid', 422)
    const [records] = await connection.execute<RecordRow[]>(`SELECT r.id,CAST(r.trading_account_id AS CHAR) account_id,r.user_id,
      r.ownership_interval_id,r.revision,r.platform,r.position_id,r.source_classification,r.status,r.attribution_status,r.currency_evidence,r.account_currency,r.evidence_sha256,
      DATE_FORMAT(r.opened_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') opened_at,DATE_FORMAT(r.closed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') closed_at,
      r.terminal_timezone_offset_minutes FROM account_trade_records_v4 r
      WHERE r.id=? AND r.user_id=? AND ${provenHistoryRecordSql()} LIMIT 1 FOR SHARE`, [input.recordId, input.userId])
    const row = records[0]
    if (!row) return unresolved('record_unavailable')
    if (Number(row.revision) !== input.expectedRevision) return unresolved('revision_changed')
    const admitted = verifySystem ? row.platform === 'mt5' && ['unknown', 'system'].includes(row.source_classification)
      : row.attribution_status === 'exact' && ['system', 'manual'].includes(row.source_classification)
    if (row.status !== 'closed' || !admitted
      || row.currency_evidence !== 'explicit_record' || !row.account_currency) return unresolved('record_not_eligible')
    const [facts] = await connection.execute<FactRow[]>(`SELECT d.id,d.deal_ticket,d.evidence_sha256,d.evidence_json
      FROM account_trade_record_deals_v4 x LEFT JOIN terminal_history_deals_v4 d
        ON d.id=x.terminal_deal_id AND d.trading_account_id=? AND d.platform=?
      WHERE x.trade_record_id=? ORDER BY x.sequence_number,d.id LIMIT 1001 FOR SHARE`, [row.account_id, row.platform, row.id])
    if (!facts.length || facts.length > 1000 || facts.some(fact => !fact.id)
      || new Set(facts.map(fact => fact.id)).size !== facts.length) return unresolved('facts_incomplete')
    const captured = facts.map(fact => {
      const raw = typeof fact.evidence_json === 'string' ? fact.evidence_json : JSON.stringify(fact.evidence_json)
      const costs = readTradeCostEvidence(raw, fact.evidence_sha256)
      const original = JSON.parse(raw) as Record<string, unknown>
      try {
        const decoded = decodeTerminalHistoryPage(row.platform === 'mt4' ? 'mt4_closed_trades' : 'deals', [original])[0]
        if (!decoded || decoded.kind !== 'deal' || decoded.ticket !== fact.deal_ticket) throw new Error('mismatch')
      } catch { throw new TradeHistoryError('review_trade_fact_identity_invalid', 409) }
      return { id: fact.id!, ticket: fact.deal_ticket, hash: fact.evidence_sha256, raw: original, costs }
    })
    const hash = row.platform === 'mt4' && captured.length === 1 ? captured[0]!.hash
      : createHash('sha256').update(captured.map(fact => fact.hash).sort().join('|')).digest('hex')
    if (hash !== row.evidence_sha256) return unresolved('facts_incomplete')
    if (captured.some(fact => !fact.costs.complete)) return unresolved('cost_fields_incomplete')
    const projection = reconstructReviewTrade(row.platform, row.position_id, captured.map(fact => fact.raw))
    if (!projection || projection.currencyEvidence !== 'explicit_record' || projection.accountCurrency !== row.account_currency
      || projection.openedAtUtcMsc !== Date.parse(row.opened_at) || projection.closedAtUtcMsc !== Date.parse(row.closed_at)
      || projection.evidenceHash !== hash) return unresolved('lifecycle_incomplete')
    if (verifySystem && !await verifySystem(captured.map(fact => decodeTerminalHistoryPage('deals', [fact.raw])[0] as TerminalDealFact))) {
      return unresolved('record_not_eligible')
    }
    return { status: 'captured', evidence: { recordId: row.id, accountId: row.account_id, userId: input.userId,
      ownershipIntervalId: row.ownership_interval_id, revision: Number(row.revision), platform: row.platform, source: verifySystem ? 'system' : row.source_classification,
      openedAt: row.opened_at.replace(/(\.\d{3})000Z$/, '$1Z'), closedAt: row.closed_at.replace(/(\.\d{3})000Z$/, '$1Z'),
      terminalTimezoneOffsetMinutes: row.terminal_timezone_offset_minutes, evidenceHash: hash, projection, facts: captured } }
  } }
}
