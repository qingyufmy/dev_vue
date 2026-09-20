import { createHash } from 'node:crypto'
import { ReviewError } from '../domain/review.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
export function reviewEvidenceHash(value: Record<string, unknown>): string { return digest(canonical(value)) }

const manualKeys = ['schema_version', 'source', 'user_thesis', 'trades']
const tradeKeys = ['candidate_id', 'account_id', 'ticket', 'position_id', 'symbol', 'side', 'volume', 'opened_at', 'closed_at', 'net_profit', 'evidence_sha256']
function ordered(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return null
  return Object.fromEntries(keys.map(key => [key, record[key]]))
}

/** MySQL JSON changes key order. Old manual evidence used a fixed writer order. */
export function verifiedReviewEvidence(raw: unknown, expectedHash: string): Record<string, unknown> {
  const invalid = (): never => { throw new ReviewError('review_job_evidence_hash_mismatch', 409) }
  let value: unknown
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !/^[a-f0-9]{64}$/.test(expectedHash)) return invalid()
  const evidence = value as Record<string, unknown>
  if (reviewEvidenceHash(evidence) === expectedHash || digest(JSON.stringify(evidence)) === expectedHash) return evidence
  const legacy = ordered(evidence, manualKeys)
  if (legacy?.schema_version === 'review-evidence.v4.1' && legacy.source === 'manual_trade' && Array.isArray(legacy.trades)) {
    const trades = legacy.trades.map(item => ordered(item, tradeKeys))
    if (trades.every(item => item !== null) && digest(JSON.stringify({ ...legacy, trades })) === expectedHash) return evidence
  }
  return invalid()
}
