import { expect, it } from 'vitest'
import { sha256Canonical } from '../src/shared/canonical-json.js'
import { contentHash } from '../src/modules/inference/domain/inference.js'
import { publicMacroSnapshot, macroSnapshotSummary, type MacroSnapshotRecord } from '../src/modules/market/domain/macro-snapshot.js'

const now = '2026-09-09T12:00:00.000Z'
const factor = { code: 'DFII10', label: '实际利率', value: '1.1234567890', unit: '%',
  observation_at: '2026-09-08T00:00:00.000Z', available_at: '2026-09-09T00:00:00.000Z', freshness: 'fresh', gold_relation: 'adverse' }
function fixture() {
  const payload = { display: { direction: 'uncertain', summary: '因子存在分歧', factors: [{ ...factor, raw_response: 'private' }], internal: 'private' },
    analysis_evidence: { private: 'model-only' }, provider_licenses: 'private' }
  const record: MacroSnapshotRecord = { id: 'snapshot-1', schemaVersion: 1, revision: '9007199254740993', businessDate: '2026-09-09', horizon: 'medium_term',
    dataCutoffAt: '2026-09-09T00:00:00.000Z', publishedAt: '2026-09-09T01:00:00.000Z', validUntil: '2026-09-10T00:00:00.000Z',
    status: 'fresh', contentSha256: sha256Canonical(payload), payload }
  return { payload, record }
}

it('hashes the complete storage payload using compatible canonical encoding and exposes only display fields', () => {
  const { payload, record } = fixture()
  expect(record.contentSha256).toBe(contentHash(payload))
  const snapshot = publicMacroSnapshot(record, now)
  expect(snapshot.factors).toEqual([factor])
  expect(snapshot.revision).toBe('9007199254740993')
  expect(JSON.stringify(snapshot)).not.toMatch(/private|model-only|raw_response|analysis_evidence/)
  expect(macroSnapshotSummary(snapshot)).toMatchObject({ factor_count: 1 })
  expect(macroSnapshotSummary(snapshot)).not.toHaveProperty('factors')
  expect(publicMacroSnapshot({ ...record, payload: JSON.stringify(payload) }, now)).toEqual(snapshot)
})

it('rejects hash changes including changes in undisplayed fields and never falls back to evidence', () => {
  const { record, payload } = fixture()
  for (const changed of [{ ...payload, provider_licenses: 'changed' }, { analysis_evidence: payload.display }]) {
    expect(() => publicMacroSnapshot({ ...record, payload: changed }, now)).toThrow('macro_snapshot_data_invalid')
  }
  const evidenceOnly = { analysis_evidence: payload.display }
  expect(() => publicMacroSnapshot({ ...record, payload: evidenceOnly, contentSha256: sha256Canonical(evidenceOnly) }, now)).toThrow()
})

it('rejects invalid metadata, duplicate/future factors, malformed values and unverified aggregate direction', () => {
  const { record, payload } = fixture()
  for (const patch of [{ schemaVersion: 2 }, { revision: '1e3' }, { businessDate: '2026-02-30' }, { publishedAt: '2026-09-11T00:00:00.000Z' }]) {
    expect(() => publicMacroSnapshot({ ...record, ...patch }, now)).toThrow()
  }
  for (const display of [{ ...payload.display, direction: 'supportive' }, { ...payload.display, factors: [factor, factor] },
    { ...payload.display, factors: [{ ...factor, value: 1.2 }] },
    { ...payload.display, factors: [{ ...factor, available_at: '2026-09-10T00:00:00.000Z' }] }]) {
    const changed = { ...payload, display }
    expect(() => publicMacroSnapshot({ ...record, payload: changed, contentSha256: sha256Canonical(changed) }, now)).toThrow()
  }
})

it('marks expired historical projections stale without changing stored content hash or unavailable status', () => {
  const { record } = fixture()
  expect(publicMacroSnapshot(record, record.validUntil)).toMatchObject({ status: 'stale', content_sha256: record.contentSha256 })
  expect(publicMacroSnapshot({ ...record, status: 'unavailable' }, record.validUntil).status).toBe('unavailable')
})
