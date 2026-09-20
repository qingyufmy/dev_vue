import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { reviewEvidenceHash, verifiedReviewEvidence } from '../src/modules/reviews/infrastructure/review-evidence-integrity.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value
const legacy = { schema_version: 'review-evidence.v4.1', source: 'manual_trade', user_thesis: null, trades: [{
  candidate_id: 'c1', account_id: '5', ticket: '10', position_id: null, symbol: 'XAUUSD', side: 'buy', volume: '0.01',
  opened_at: '2026-09-11T00:00:00.000Z', closed_at: '2026-09-11T01:00:00.000Z', net_profit: '1.00', evidence_sha256: 'a'.repeat(64),
}] }
describe('frozen review evidence integrity', () => {
  it('survives MySQL JSON key reordering for new and legacy manual hashes', () => {
    const reordered = reverse(legacy)
    expect(verifiedReviewEvidence(reordered, reviewEvidenceHash(legacy))).toEqual(legacy)
    expect(verifiedReviewEvidence(JSON.stringify(reordered), hash(legacy))).toEqual(legacy)
  })
  it('rejects altered values and additional fields under both hash formats', () => {
    for (const expected of [hash(legacy), reviewEvidenceHash(legacy)]) {
      const changed = structuredClone(legacy); changed.trades[0]!.net_profit = '100.00'
      expect(() => verifiedReviewEvidence(changed, expected)).toThrow('review_job_evidence_hash_mismatch')
      expect(() => verifiedReviewEvidence({ ...legacy, extra: 'unverified' }, expected)).toThrow('review_job_evidence_hash_mismatch')
      expect(() => verifiedReviewEvidence({ ...legacy, trades: [{ ...legacy.trades[0], extra: true }] }, expected)).toThrow('review_job_evidence_hash_mismatch')
    }
  })
  it('rejects malformed payloads and does not reorder evidence arrays', () => {
    for (const raw of ['{', '[]', 'null']) expect(() => verifiedReviewEvidence(raw, hash({}))).toThrow('review_job_evidence_hash_mismatch')
    expect(() => verifiedReviewEvidence({ ids: [2, 1] }, reviewEvidenceHash({ ids: [1, 2] }))).toThrow('review_job_evidence_hash_mismatch')
  })
})
