import { createHash } from 'node:crypto'
import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectMembershipSources } from './v4-membership-source.mjs'
import { createMembershipBackfill } from './v4-membership-backfill.mjs'

// reviewBytes must be the independently verified, immutable read-only review.
// Scope includes the complete user projection so a changed/deferred user cannot
// silently enter a previously approved null-expiry wave.
export function prepareNullExpiryMembershipBackfill(users, run, reviewBytes) {
  const review = JSON.parse(Buffer.from(reviewBytes).toString('utf8'))
  const all = inspectMembershipSources(users, [], []).entries.map(entry => entry.source)
  check(review.kind === 'membership-null-expiry-review/v1' && review.identity?.db === 'dev_vue'
    && review.identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104' && review.schemaSteps === 51
    && review.allUserRows === all.length && review.allUserSourceHash === hash(all), 'null_membership_review_scope')
  const expectedRule = { sourcePredicate: 'plan_expires_at IS NULL', targetExpirationKind: 'no_expiry', targetExpiresAtUtc: null,
    sourceUpdatedAtDisposition: 'preserve_raw_archive', observedAtDisposition: 'migration_registration_time',
    createsPurchaseOrHistoricalGrant: false, convertsHistoricalTime: false }
  check(canonical(review.rule) === canonical(expectedRule)
    && canonical(review.policyCases) === canonical(['free', 'plus', 'pro'].map(plan => ({ plan, legacy: plan, normalized: plan })))
    && [review.referenceSha256, review.normalizedDomainSourceSha256, review.normalizedDomainBuildSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'null_membership_review_rule')
  const selected = all.filter(user => user.plan_expires_at === null)
  check(selected.length === review.sourceRows && hash(selected) === review.sourceHash
    && all.length - selected.length === review.deferredNonNullExpiryRows, 'null_membership_review_selection')
  const reviewSha256 = createHash('sha256').update(reviewBytes).digest('hex')
  const options = { run, evidenceCatalog: new Map([['reviewed-null-expiry-policy', reviewSha256]]),
    basis: { version: 'membership-current-state/v1', sourceHash: hash(selected), sourceSnapshotId: run.sourceSnapshotId,
      resolutions: selected.map(source => ({ sourceId: source.id, sourceHash: hash(source), rawExpiry: null,
        expirationKind: 'no_expiry', offsetMinutes: null, evidenceId: 'reviewed-null-expiry-policy', evidenceSha256: reviewSha256 })) } }
  return { recipe: createMembershipBackfill(selected, options, { batchSize: 10 }), options,
    selected: structuredClone(selected), deferredSourceIds: all.filter(user => user.plan_expires_at !== null).map(user => user.id), reviewSha256 }
}
