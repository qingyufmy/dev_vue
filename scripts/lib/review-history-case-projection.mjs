import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hash, canonical, streamIdentity } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { legacyReviewId, projectLegacyReviewVersions, validateReviewHistoryBundle } from './review-history-bundle.mjs'
import { reviewChunkRole } from './review-history-chunk-batch.mjs'

const utc = value => { const result = inspectWallClock(value).canonicalWallClock; assert.ok(result); return result }
const epoch = value => {
  const text = String(value); assert.match(text, /^[1-9]\d{0,15}$/)
  const n = Number(text); assert.ok(Number.isSafeInteger(n))
  const date = new Date(n).toISOString(); assert.match(date, /^\d{4}-/)
  return date.slice(0, 23).replace('T', ' ')
}
const nullableId = value => { if (value === null || value === undefined) return null; const text = String(value); assert.match(text, /^[1-9]\d{0,19}$/); return text }

export function projectArchivedReviewCase(bundle, { archiveRunId, accountId }) {
  const { sourceHash } = validateReviewHistoryBundle(bundle), source = bundle.rows[bundle.table][0]
  assert.match(archiveRunId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/); nullableId(accountId); assert.ok(accountId)
  const evidence = JSON.parse(source.evidence_json), id = legacyReviewId(bundle.table, bundle.id)
  let kind, start, end, offset, timezoneSource, symbol = null, strategyId, strategyVersion
  if (bundle.table === 'period_review_cases') {
    kind = source.period_type; assert.ok(['daily', 'monthly'].includes(kind))
    start = epoch(source.period_start_utc_msc); end = epoch(source.period_end_utc_msc)
    offset = source.timezone_offset_minutes; timezoneSource = 'legacy_case'
    strategyId = source.strategy_id; strategyVersion = source.strategy_version
  } else if (bundle.table === 'manual_trade_review_cases') {
    kind = 'manual'; const trades = bundle.rows.manual_trade_review_sources; assert.ok(trades.length)
    start = trades.map(row => epoch(row.entry_time_utc_msc)).sort()[0]
    end = trades.map(row => epoch(row.close_time_utc_msc)).sort().at(-1)
    const symbols = new Set(trades.map(row => row.symbol)); symbol = symbols.size === 1 ? [...symbols][0] : null
    offset = evidence.timezone_offset_minutes; timezoneSource = 'legacy_evidence'
    strategyId = source.strategy_id; strategyVersion = source.strategy_version
  } else {
    kind = 'trade'; const path = evidence.post_trade.path_metrics
    start = epoch(path.entry_time_utc_msc); end = epoch(path.exit_time_utc_msc)
    symbol = evidence.post_trade.outcome.symbol
    strategyId = evidence.inference_time.snapshot?.strategy_id; strategyVersion = evidence.inference_time.snapshot?.strategy_version
  }
  assert.ok(end > start, 'review_history_period_invalid')
  if (offset === null || offset === undefined) { offset = 180; timezoneSource = 'default_utc_plus_3' }
  const timezone = Number(offset); assert.ok(Number.isInteger(timezone) && timezone >= -840 && timezone <= 840)
  if (symbol !== null) assert.ok(typeof symbol === 'string' && /^[\x20-\x7e]{1,64}$/.test(symbol))
  const versions = projectLegacyReviewVersions(bundle)
  const versionId = oldId => oldId === null ? null : versions.find(row => row.content.sourceId === oldId).id
  const caseRow = { id, user_id: source.user_id, trading_account_id: String(accountId), kind, scope_key: `legacy:${bundle.table}:${bundle.id}`,
    standard_symbol: symbol, subscription_id: null, subscription_revision: null, analysis_strategy_id: null, analysis_strategy_version_id: null,
    trader_strategy_id: null, trader_strategy_version_id: null, terminal_period_start_utc: start, terminal_period_end_utc: end,
    terminal_timezone_offset_minutes: timezone, status: 'archived', evidence_status: 'stale', evidence_revision: 1,
    evidence_sha256: sourceHash, current_version_id: versionId(source.current_version_id), confirmed_version_id: versionId(source.approved_version_id),
    review_eligible_at_utc: null, confirmed_by_user_id: null, confirmed_at_utc: null, return_reason: null,
    legacy_source_table: bundle.table, legacy_id: bundle.id, created_at_utc: utc(source.created_at), updated_at_utc: utc(source.updated_at), revision: 1 }
  const historyRow = { review_case_id: id, source_table: bundle.table, source_id: bundle.id,
    source_status: source.status, source_evidence_status: source.evidence_status,
    source_strategy_id: nullableId(strategyId), source_strategy_version: nullableId(strategyVersion), archive_run_id: archiveRunId,
    archive_stream_id: streamIdentity({ sourceTable: bundle.table, role: reviewChunkRole(bundle.id) }), source_bundle_sha256: sourceHash,
    timezone_source: timezoneSource, created_at_utc: utc(source.created_at) }
  const projectedVersions = versions.map(version => {
    const { rawText, ...compact } = version.content, text = canonical(compact)
    const payloadHash = createHash('sha256').update(canonical({ compact, rawText })).digest('hex')
    return { row: { id: version.id, review_case_id: id, version_number: version.versionNumber, source_job_id: null,
      author_kind: version.authorKind, created_by_user_id: version.authorUserId, conclusion_code: null,
      net_profit: null, trade_count: null, win_rate_percent: null, profit_factor: null, content_sha256: payloadHash, created_at_utc: version.createdAt },
      payload: { review_version_id: version.id, content_json: text, full_analysis_text: rawText,
        payload_sha256: payloadHash, payload_bytes: Buffer.byteLength(text) + Buffer.byteLength(rawText) } }
  })
  const userStates = (bundle.rows.period_review_user_states ?? []).map(row => ({ review_case_id: id, user_id: row.user_id,
    seen_version_id: versionId(row.last_seen_version_id), seen_at_utc: row.last_seen_at === null ? null : utc(row.last_seen_at), revision: 1 }))
  return { caseRow, historyRow, versions: projectedVersions, userStates }
}
