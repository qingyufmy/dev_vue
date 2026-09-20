import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertFrozenMigrationPrefix } from './frozen-migration-prefix.mjs'

const plan = [{ id: 'bootstrap_v4_foundation_v1', checksum: 'a', statements: [] }, { id: '20260101_001_base', checksum: 'b', statements: [] }]
const reference = [...plan].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ id: row.id, checksum_sha256: row.checksum, status: 'completed' }))
const check = (r, p) => assertFrozenMigrationPrefix(r, p, ['protected_table'], 'history_changed')
test('accepts only an unchanged ordered prefix and labels the appended suffix unproven', () => {
  assert.deepEqual(check(reference, [...plan, { id: '20260102_002_other', checksum: 'c', statements: ['CREATE TABLE other_table (id INT)'] }]),
    { frozenMigrationCount: 2, appendedUnprovenMigrationCount: 1 })
})
test('rejects changed, deleted, reordered, duplicate and incomplete frozen evidence', () => {
  for (const candidate of [[...plan].reverse(), plan.slice(1), [{ ...plan[0], checksum: 'changed' }, plan[1]]]) assert.throws(() => check(reference, candidate), /history_changed/)
  for (const candidate of [[...reference].reverse(), [reference[0], reference[0]], reference.map(row => ({ ...row, status: 'started' }))]) assert.throws(() => check(candidate, plan), /history_changed/)
})
test('rejects appended changes and dependencies on protected tables', () => {
  for (const sql of ['ALTER TABLE protected_table ADD COLUMN x INT', 'ALTER TABLE `PROTECTED_TABLE` ADD COLUMN x INT', 'CREATE TABLE other (id INT REFERENCES protected_table(id))']) {
    assert.throws(() => check(reference, [...plan, { id: '20260102_002_other', checksum: 'c', statements: [sql] }]), /history_changed/)
  }
})
