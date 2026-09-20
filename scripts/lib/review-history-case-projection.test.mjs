import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewHistoryGraph } from './review-history-bundle.mjs'
import { projectArchivedReviewCase } from './review-history-case-projection.mjs'
const context = { archiveRunId: '00000000-0000-0000-0000-000000000001', accountId: '99' }
function fixture() {
  const table = 'period_review_cases', rows = Object.fromEntries(reviewHistoryGraph[table].map(([name]) => [name, []]))
  rows[table] = [{ id: '1', user_id: '29', trading_account_id: '2', period_type: 'daily', period_start_utc_msc: '1785974400000',
    period_end_utc_msc: '1786060800000', timezone_offset_minutes: '180', strategy_id: '3', strategy_version: '10',
    evidence_json: '{}', status: 'generating', evidence_status: 'complete', current_version_id: '1', approved_version_id: '1',
    created_at: '2026-08-07 05:31:03', updated_at: '2026-08-07 05:31:03' }]
  rows.period_review_versions = [{ id: '1', period_case_id: '1', version_no: '1', parent_version_id: null, author_type: 'ai', author_user_id: null,
    content_json: ' {"summary":"原文"}\r\n', content_hash: 'a'.repeat(64), change_note: null, created_at: '2026-08-07 05:31:03' }]
  return { table, id: '1', rows }
}
test('archives old running state, keeps original owner and approval, never invents current strategy or metrics', () => {
  const p = projectArchivedReviewCase(fixture(), context)
  assert.equal(p.caseRow.status, 'archived'); assert.equal(p.historyRow.source_status, 'generating')
  assert.equal(p.caseRow.user_id, '29'); assert.equal(p.caseRow.trading_account_id, '99')
  assert.equal(p.caseRow.current_version_id, p.caseRow.confirmed_version_id)
  assert.equal(p.caseRow.confirmed_at_utc, null); assert.equal(p.caseRow.confirmed_by_user_id, null)
  assert.equal(p.caseRow.trader_strategy_id, null); assert.equal(p.historyRow.source_strategy_version, '10')
  assert.equal(p.versions[0].row.trade_count, null); assert.equal(p.versions[0].row.conclusion_code, null)
  assert.equal(p.versions[0].payload.full_analysis_text, fixture().rows.period_review_versions[0].content_json)
  assert.equal(p.caseRow.created_at_utc, '2026-08-07 05:31:03.000')
})
test('labels the user-approved display default and rejects invalid source periods', () => {
  const b = fixture(); b.rows.period_review_cases[0].timezone_offset_minutes = null
  const p = projectArchivedReviewCase(b, context)
  assert.equal(p.caseRow.terminal_timezone_offset_minutes, 180); assert.equal(p.historyRow.timezone_source, 'default_utc_plus_3')
  b.rows.period_review_cases[0].period_end_utc_msc = b.rows.period_review_cases[0].period_start_utc_msc
  assert.throws(() => projectArchivedReviewCase(b, context), /review_history_period_invalid/)
})
