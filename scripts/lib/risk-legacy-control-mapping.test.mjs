import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyRiskUtc, mapLegacyRiskControl } from './risk-legacy-control-mapping.mjs'

const row = { id: 1, global_kill_switch: 1, reason: '暂停新增风险', changed_by: 7, updated_at: '2026-09-09 08:01:02' }
const users = new Set(['7'])

test('preserves enabled state, reason, actor and UTC independently of local timezone', () => {
  const mapped = mapLegacyRiskControl([row], users)
  assert.deepEqual(mapped.target, { id: 1, kill_switch: 1, reason: row.reason, changed_by_user_id: 7,
    revision: 1, updated_at_utc: '2026-09-09 08:01:02.000' })
  assert.equal(mapped.sourceSha256, mapLegacyRiskControl([{ ...row }], users).sourceSha256)
  assert.notEqual(mapped.sourceSha256, mapLegacyRiskControl([{ ...row, reason: 'changed' }], users).sourceSha256)
  assert.deepEqual(mapped.source, row)
})

test('system actor maps to nullable reference while preserving original zero', () => {
  const mapped = mapLegacyRiskControl([{ ...row, changed_by: 0 }], new Set())
  assert.equal(mapped.target.changed_by_user_id, null)
  assert.equal(mapped.source.changed_by, 0)
  assert.equal(mapped.actorMapping, 'legacy_system_zero_to_null')
  assert.throws(() => mapLegacyRiskControl([row], new Set()), /actor_missing/)
})

test('missing, duplicate, invalid and newly added fields cannot produce a default control', () => {
  for (const rows of [[], [row, row], [{ ...row, global_kill_switch: 2 }], [{ ...row, global_kill_switch: false }],
    [{ ...row, id: 2 }], [{ ...row, unknown: 'preserve me' }], [{ ...row, changed_by: -1 }]]) {
    assert.throws(() => mapLegacyRiskControl(rows, users))
  }
})

test('UTC conversion preserves milliseconds and rejects invalid calendars and offsets', () => {
  assert.equal(legacyRiskUtc('2024-02-29 23:59:59.12'), '2024-02-29T23:59:59.120Z')
  for (const value of ['2026-02-29 00:00:00', '2026-09-09T08:00:00+08:00', '0000-00-00 00:00:00',
    '2026-09-09 24:00:00', null, new Date()]) assert.throws(() => legacyRiskUtc(value))
})
