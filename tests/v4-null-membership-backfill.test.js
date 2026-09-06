import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { prepareNullExpiryMembershipBackfill } from '../scripts/lib/v4-null-membership-backfill.mjs'
import { membershipFixture } from './fixtures/membership-fixture.mjs'
function fixture() {
  const f = membershipFixture(null), users = [f.user, { ...f.user, id: '3', plan_expires_at: '2027-01-01 00:00:00' }]
  const review = JSON.parse(readFileSync(new URL('../docs/migration/dev-vue-null-membership-review-20260907.json', import.meta.url), 'utf8'))
  Object.assign(review, { allUserRows: 2, allUserSourceHash: hash(users), sourceRows: 1, sourceHash: hash([users[0]]), deferredNonNullExpiryRows: 1 })
  return { users, review, run: f.options.run, bytes: () => Buffer.from(JSON.stringify(review)) }
}
it('selects only reviewed null-expiry users and binds the actual review bytes to every resolution', () => {
  const f = fixture(), result = prepareNullExpiryMembershipBackfill(f.users, f.run, f.bytes())
  expect(result.selected.map(row => row.id)).toEqual(['2'])
  expect(result.deferredSourceIds).toEqual(['3'])
  expect(result.recipe.batches[0].rows[0].payload.resolution).toMatchObject({ expirationKind: 'no_expiry', offsetMinutes: null, evidenceSha256: result.reviewSha256 })
})
it('rejects source changes including changes to deferred users', () => {
  for (const index of [0, 1]) {
    const f = fixture(); f.users[index].plan = 'free'
    expect(() => prepareNullExpiryMembershipBackfill(f.users, f.run, f.bytes())).toThrow('null_membership_review_scope')
  }
})
it('rejects a different selection or a rule that creates historical grants', () => {
  const f = fixture(); f.review.rule.createsPurchaseOrHistoricalGrant = true
  expect(() => prepareNullExpiryMembershipBackfill(f.users, f.run, f.bytes())).toThrow('null_membership_review_rule')
  const g = fixture(); g.review.sourceRows = 2
  expect(() => prepareNullExpiryMembershipBackfill(g.users, g.run, g.bytes())).toThrow('null_membership_review_selection')
})
