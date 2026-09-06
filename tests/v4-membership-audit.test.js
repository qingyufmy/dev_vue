import { expect, it } from 'vitest'
import { hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { createMembershipBackfill } from '../scripts/lib/v4-membership-backfill.mjs'
import { auditMembershipImport } from '../scripts/lib/v4-membership-audit.mjs'
import { membershipFixture } from './fixtures/membership-fixture.mjs'
function fixture(expiry) {
  const f = membershipFixture(expiry), recipe = createMembershipBackfill([f.user], f.options), row = recipe.batches[0].rows[0]
  const actual = [structuredClone(row.payload.entry.target)]
  const archives = [{ sourceId: f.user.id, runId: f.options.run.id, sourceHash: hash(f.user), sourcePkHash: hash(row.pk),
    payload: recipe.sourceEvidence(streamIdentity(recipe.stream), row) }]
  return { ...f, actual, archives, audit() { return auditMembershipImport([this.user], this.actual, this.archives, this.options) } }
}
it('verifies every target column and full source archive for timed and no-expiry imports', () => {
  for (const expiry of ['2026-01-01 13:14:15', null]) {
    expect(fixture(expiry).audit()).toMatchObject({ importMatchesReviewedInputs: true, businessCutoverVerified: false, deletionAuthorized: false })
  }
})
it('detects alteration of each of the 12 target columns', () => {
  for (const field of Object.keys(fixture().actual[0])) {
    const f = fixture(), row = f.actual[0]
    row[field] = field.endsWith('_utc') ? '2000-01-01 00:00:00' : row[field] === null ? '' : 'changed'
    expect(f.audit().importMatchesReviewedInputs).toBe(false)
  }
})
it('detects every archived source field alteration even if its public hash is updated', () => {
  for (const field of Object.keys(fixture().user)) {
    const f = fixture(), archive = f.archives[0]
    archive.payload.source[field] = archive.payload.source[field] === null ? '' : null
    archive.sourceHash = hash(archive.payload.source)
    expect(f.audit().importMatchesReviewedInputs).toBe(false)
  }
})
it('rejects changed evidence and finds missing, extra and duplicate rows', () => {
  const f = fixture(); f.options.evidenceCatalog.clear()
  expect(() => f.audit()).toThrow('membership_audit_evidence')
  const g = fixture(); g.actual = []
  expect(g.audit().differences).toContainEqual({ sourceId: '2', field: 'target', code: 'missing' })
  const h = fixture(); h.archives.push({ ...h.archives[0], sourceId: '9' })
  expect(h.audit().differences).toContainEqual({ sourceId: '9', field: 'archive', code: 'unexpected' })
  const i = fixture(); i.actual.push(i.actual[0])
  expect(() => i.audit()).toThrow('membership_audit_duplicate_target')
})
