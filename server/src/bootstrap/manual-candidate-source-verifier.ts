import type { PoolConnection } from 'mysql2/promise'
import { createTransactionReviewTradeEvidenceReader } from '../modules/trade-history/composition.js'
import { createMysqlOwnedHistoryAccess } from '../modules/trading/composition.js'
import { createActivePrincipalAccess } from '../modules/auth/composition.js'
import { ReviewError, type ManualCandidateSourceVerifier } from '../modules/reviews/index.js'
import { sha256Canonical } from '../shared/canonical-json.js'

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null

export function createTransactionManualCandidateSourceVerifier(connection: PoolConnection): ManualCandidateSourceVerifier {
  const trades = createTransactionReviewTradeEvidenceReader(connection)
  const ownership = createMysqlOwnedHistoryAccess(connection, createActivePrincipalAccess(connection))
  return { async verify(payload, userId) {
    const frozen = object(object(payload.trade)?.evidence), authority = object(payload.authority)
    const previousOwner = object(authority?.ownership)
    if (!frozen || frozen.userId !== userId || typeof frozen.recordId !== 'string'
      || typeof frozen.revision !== 'number' || !previousOwner) throw new ReviewError('manual_review_source_unavailable', 409)
    const current = await trades.read({ userId, recordId: frozen.recordId, expectedRevision: frozen.revision })
    if (current.status !== 'captured' || current.evidence.source !== 'manual'
      || sha256Canonical(current.evidence) !== sha256Canonical(frozen)) throw new ReviewError('manual_review_source_changed', 409)
    const e = current.evidence
    const owned = await ownership.read({ userId, accountId: e.accountId, platform: e.platform,
      ownershipIntervalId: e.ownershipIntervalId, openedAt: e.openedAt, closedAt: e.closedAt })
    if (!owned || sha256Canonical(owned) !== sha256Canonical(previousOwner)) throw new ReviewError('manual_review_source_changed', 409)
  } }
}
