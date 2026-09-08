import { expect, it } from 'vitest'
import { sha256Canonical } from '../src/shared/canonical-json.js'
import { projectReadableMacroSnapshot } from '../src/modules/market/application/macro-snapshot-projection.js'
import type { ReadableMacroSnapshot } from '../src/modules/market/application/macro-snapshot-reader.js'

const cutoff = '2026-09-09T00:00:00.000Z'
function fixture(): ReadableMacroSnapshot {
  const factor = { code: 'DFII10', label: '实际利率', value: '1.82', unit: '%', observation_at: cutoff,
    available_at: cutoff, freshness: 'fresh', gold_relation: 'adverse' }
  const payload = { display: { direction: 'uncertain', summary: '背景数据', factors: [factor] } }
  return { record: { id: 'snapshot-1', schemaVersion: 1, revision: '1', businessDate: '2026-09-09', horizon: 'medium_term',
    dataCutoffAt: cutoff, publishedAt: '2026-09-09T01:00:00.000Z', validUntil: '2026-09-10T00:00:00.000Z', status: 'fresh',
    payload, contentSha256: sha256Canonical(payload) }, observations: [{ factorCode: factor.code,
    observationAt: cutoff, availableAt: cutoff, ingestedAt: cutoff, value: '1.8200000000' }] }
}

it('matches exact decimal values without requiring equal trailing-zero formatting', () => {
  expect(projectReadableMacroSnapshot(fixture(), '2026-09-09T02:00:00.000Z').factors[0]?.value).toBe('1.82')
})

it('rejects absent, wrong-code, wrong-vintage or altered-value lineage', () => {
  for (const patch of [{ factorCode: 'OTHER' }, { availableAt: '2026-09-08T00:00:00.000Z' }, { value: '1.8200000001' }]) {
    const input = fixture()
    Object.assign(input.observations[0]!, patch)
    expect(() => projectReadableMacroSnapshot(input, '2026-09-09T02:00:00.000Z')).toThrow('macro_snapshot_lineage_invalid')
  }
  expect(() => projectReadableMacroSnapshot({ ...fixture(), observations: [] }, '2026-09-09T02:00:00.000Z')).toThrow()
})

it('rejects any future ingestion in the complete lineage even if the row is not a displayed factor', () => {
  const input = fixture()
  input.observations.push({ ...input.observations[0]!, factorCode: 'INTERNAL_FACTOR', ingestedAt: '2026-09-09T01:00:00.000Z' })
  expect(() => projectReadableMacroSnapshot(input, '2026-09-09T02:00:00.000Z')).toThrow('macro_snapshot_lineage_invalid')
})
