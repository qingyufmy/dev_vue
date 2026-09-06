import { expect, it } from 'vitest'
import { reviewTableDependencies } from '../scripts/lib/inplace-table-dependencies.mjs'

const create = (name, fields) => `CREATE TABLE ${name} (\n${fields}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
const plan = statements => [{ id: 'fixture', file: 'fixture.sql', checksum: 'fixture', statements }]
const source = { tables: [{ table_name: 'parents' }], columns: [{ table_name: 'parents', column_name: 'id', column_type: 'int', collation: null }] }
it('propagates a legacy primary-key type mismatch through the complete dependency chain', () => {
  const result = reviewTableDependencies(plan([
    create('parents', 'id BIGINT UNSIGNED NOT NULL'),
    create('children', 'id BIGINT UNSIGNED NOT NULL,\nparent_id BIGINT UNSIGNED NOT NULL,\nCONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parents (id)'),
    create('leaves', 'id BIGINT UNSIGNED NOT NULL,\nchild_id BIGINT UNSIGNED NOT NULL,\nCONSTRAINT fk_child FOREIGN KEY (child_id) REFERENCES children (id)'),
  ]), source)
  expect(result.summary).toEqual({ newTables: 2, candidates: 0, blocked: 2 })
  expect(result.tables[0].blockers[0].code).toBe('foreign_key_type_mismatch')
  expect(result.tables[1].blockers[0].code).toBe('blocked_parent')
})
it('does not mistake deferred foreign keys for a creation cycle', () => {
  const result = reviewTableDependencies(plan([
    create('first', 'id INT NOT NULL,\nsecond_id INT NULL'),
    create('second', 'id INT NOT NULL,\nfirst_id INT NOT NULL,\nCONSTRAINT fk_first FOREIGN KEY (first_id) REFERENCES first (id)'),
    'ALTER TABLE first ADD CONSTRAINT fk_second FOREIGN KEY (second_id) REFERENCES second (id)',
  ]), { tables: [], columns: [] })
  expect(result.candidateOrder).toEqual(['first', 'second'])
  expect(result.executable).toBe(false)
})
it('rejects an old table with a differently named primary key', () => {
  const old = { ...source, columns: [{ ...source.columns[0], column_name: 'task_id' }] }
  const result = reviewTableDependencies(plan([create('parents', 'id INT NOT NULL'),
    create('children', 'id INT NOT NULL,\nCONSTRAINT fk_parent FOREIGN KEY (id) REFERENCES parents (id)')]), old)
  expect(result.tables[0].blockers[0].code).toBe('referenced_column_missing_or_unsupported')
})
it('requires matching string collations', () => {
  const old = { ...source, columns: [{ ...source.columns[0], column_type: 'varchar(32)', collation: 'utf8mb4_general_ci' }] }
  const result = reviewTableDependencies(plan([create('parents', 'id VARCHAR(32) NOT NULL'),
    create('children', 'id VARCHAR(32) NOT NULL,\nCONSTRAINT fk_parent FOREIGN KEY (id) REFERENCES parents (id)')]), old)
  expect(result.tables[0].blockers[0].code).toBe('foreign_key_collation_mismatch')
})
