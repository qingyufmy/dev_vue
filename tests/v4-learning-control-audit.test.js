import { expect, it } from 'vitest'
import { verifyLearningMigrationControl } from '../scripts/lib/v4-learning-control-audit.mjs'
import { createLearningCourseBackfill } from '../scripts/lib/v4-learning-course-backfill.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningControlFixture } from './fixtures/learning-control-fixture.mjs'
function fixture() {
  const { source, options } = learningCourseFixture(), pipeline = createLearningCourseBackfill([source], options)
  const spec = { runId: pipeline.runId, bindings: { transformHash: pipeline.transformHash, logicalSourceId: 'fixture' } }
  const rows = learningControlFixture(spec, pipeline)
  return { rows, audit: () => {
    const replies = Object.values(rows)
    return verifyLearningMigrationControl({ execute: async () => [replies.shift()] }, spec, pipeline)
  } }
}
it('checks batches, every receipt, final checkpoint and both parent mappings', async () => {
  expect(await fixture().audit()).toMatchObject({ verified: true, batches: 1, receipts: 1, checkpoints: 1, mappings: 2 })
})
it.each(['batches', 'receipts', 'checkpoints', 'maps'])('rejects missing, extra or duplicated %s', async table => {
  for (const change of [rows => rows.pop(), rows => rows.push({ ...rows[0] })]) {
    const f = fixture(); change(f.rows[table])
    await expect(f.audit()).rejects.toThrow('learning_control_')
  }
})
it('detects each stored field changing independently even when business rows are intact', async () => {
  for (const [table, records] of Object.entries(fixture().rows)) for (const field of Object.keys(records[0])) {
    const f = fixture()
    f.rows[table][0][field] = field.endsWith('_json') ? '{}' : 'changed'
    await expect(f.audit(), `${table}.${field}`).rejects.toThrow('learning_control_')
  }
})
it('rejects malformed JSON rather than treating it as a missing optional value', async () => {
  const f = fixture(); f.rows.receipts[0].targets_json = '{broken'
  await expect(f.audit()).rejects.toThrow('learning_control_json_invalid')
})
