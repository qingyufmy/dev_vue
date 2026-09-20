import test from 'node:test'
import assert from 'node:assert/strict'
import { validateReviewHistoryBundle, projectLegacyReviewVersions, legacyReviewId } from './review-history-bundle.mjs'
const make = () => ({ table: 'trade_review_cases', id: '1', rows: {
  trade_review_cases: [{ id: '1', current_version_id: '10', approved_version_id: '10' }],
  trade_review_versions: [{ id: '10', case_id: '1', version_no: '1', parent_version_id: null, author_type: 'ai', author_user_id: null,
    content_json: ' {"summary":"历史😀"}\r\n', content_hash: 'a'.repeat(64), change_note: null, created_at: '2026-08-07 05:31:03' }],
} })
test('keeps raw text, original hash, UTC and stable table-scoped identities', () => {
  const bundle = make(), [version] = projectLegacyReviewVersions(bundle)
  assert.equal(version.content.rawText, bundle.rows.trade_review_versions[0].content_json)
  assert.equal(version.content.originalContentHash, 'a'.repeat(64))
  assert.equal(version.conclusion, null)
  assert.equal(version.createdAt, '2026-08-07 05:31:03.000')
  assert.equal(version.id, legacyReviewId('trade_review_versions', '10'))
  assert.notEqual(version.id, legacyReviewId('period_review_versions', '10'))
})
test('rejects cross-case versions, dangling approval and cyclic version ancestry', () => {
  const cross = make(); cross.rows.trade_review_versions[0].case_id = '2'
  assert.throws(() => validateReviewHistoryBundle(cross), /review_history_cross_case/)
  const approved = make(); approved.rows.trade_review_cases[0].approved_version_id = '11'
  assert.throws(() => validateReviewHistoryBundle(approved), /review_history_version_pointer_missing/)
  const cycle = make(); cycle.rows.trade_review_versions[0].parent_version_id = '10'
  assert.throws(() => validateReviewHistoryBundle(cycle), /review_history_parent_invalid/)
})
