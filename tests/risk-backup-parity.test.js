import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyRiskRestoredSnapshot } from '../scripts/lib/risk-backup-parity.mjs'

const source = () => [{ name: 'old_table', rows: 2, rowsSha256: 'a'.repeat(64),
  ddl: 'CREATE TABLE `old_table` (\n  `label` varchar(12) COLLATE utf8mb4_unicode_ci DEFAULT NULL\n)',
  columns: [{ name: 'label', characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', dataType: 'varchar', columnType: 'varchar(12)' }] }]
test('accepts only equivalent charset rendering after full metadata and row equality', () => {
  const before = source(), after = structuredClone(before)
  after[0].ddl = after[0].ddl.replace('varchar(12) COLLATE', 'varchar(12) CHARACTER SET utf8mb4 COLLATE')
  assert.equal(verifyRiskRestoredSnapshot(before, after).differences.length, 1)
})
test('refuses missing or duplicate tables and changed data', () => {
  assert.throws(() => verifyRiskRestoredSnapshot(source(), []), /tables_mismatch/)
  assert.throws(() => verifyRiskRestoredSnapshot([...source(), ...source()], [...source(), ...source()]), /tables_mismatch/)
  const after = source(); after[0].rowsSha256 = 'changed'
  assert.throws(() => verifyRiskRestoredSnapshot(source(), after), /rows_mismatch/)
})
test('does not normalize away changed constraints or column metadata', () => {
  const after = source(); after[0].ddl += ' ENGINE=MyISAM'
  assert.throws(() => verifyRiskRestoredSnapshot(source(), after), /ddl_mismatch/)
  const changed = source(); changed[0].columns[0].columnType = 'varchar(10)'
  assert.throws(() => verifyRiskRestoredSnapshot(source(), changed), /columns_mismatch/)
})
