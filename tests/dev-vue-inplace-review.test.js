import { describe, expect, it } from 'vitest'
import { reviewInplaceSchema } from '../scripts/lib/dev-vue-inplace-review.mjs'

const source = { database: 'dev_vue', columns: [
  { table_name: 'users', column_name: 'id' }, { table_name: 'users', column_name: 'old_flag' },
  { table_name: 'legacy_history', column_name: 'id' },
] }
const target = { users: { id: {}, revision: {} }, new_events: { id: {} } }
describe('same database upgrade review', () => {
  it('preserves source-only fields and never treats same names as compatible', () => {
    const result = reviewInplaceSchema(source, target)
    expect(result.executable).toBe(false)
    expect(result.summary).toMatchObject({ nameCollisions: 1, sourceOnly: 1, targetOnly: 1 })
    expect(result.tables.find(row => row.table === 'users')).toMatchObject({ targetColumnsAbsentInSource: ['revision'], sourceColumnsAbsentInTarget: ['old_flag'], decision: 'require_semantic_and_constraint_review' })
    expect(result.tables.find(row => row.table === 'legacy_history').decision).toBe('retain_until_explicit_field_disposition')
  })
  it('rejects a different database and duplicate source columns', () => {
    expect(() => reviewInplaceSchema({ ...source, database: 'dev_xin' }, target)).toThrow('inplace_source_invalid')
    expect(() => reviewInplaceSchema({ ...source, columns: [...source.columns, source.columns[0]] }, target)).toThrow('inplace_duplicate_column')
  })
  it('fingerprints source metadata and target changes deterministically', () => {
    expect(reviewInplaceSchema(source, target)).toEqual(reviewInplaceSchema(source, target))
    expect(reviewInplaceSchema(source, { ...target, another: { id: {} } }).targetPlanFingerprint).not.toBe(reviewInplaceSchema(source, target).targetPlanFingerprint)
  })
})
