import { expect, test } from 'vitest'
import { equivalentRestoredDdl } from '../scripts/lib/restore-ddl-equivalence.mjs'
const columns = [{ name: 'reason', dataType: 'varchar', columnType: 'varchar(1000)', characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }]
const before = "CREATE TABLE `t` (\n  `reason` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL\n) ENGINE=InnoDB"
const after = before.replace('COLLATE', 'CHARACTER SET utf8mb4 COLLATE')
test('accepts only the redundant charset token with matching column facts', () => {
  expect(equivalentRestoredDdl(before, after, columns)).toEqual({ equivalent: true,
    differences: [{ column: 'reason', change: 'explicit_redundant_utf8mb4_charset' }] })
})
test.each([
  after.replace('varchar(1000)', 'varchar(999)'), after.replace('DEFAULT NULL', "DEFAULT 'changed'"),
  after.replace('unicode_ci', 'general_ci'), after.replace('utf8mb4 COLLATE', 'latin1 COLLATE'),
  after + '\n', after.replace('ENGINE=InnoDB', 'ENGINE=MyISAM'),
])('rejects any additional DDL change', ddl => { expect(equivalentRestoredDdl(before, ddl, columns).equivalent).toBe(false) })
test('rejects charset metadata mismatch', () => {
  expect(equivalentRestoredDdl(before, after, [{ ...columns[0], characterSet: 'latin1' }]).equivalent).toBe(false)
})
