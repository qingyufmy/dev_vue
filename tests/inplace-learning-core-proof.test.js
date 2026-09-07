import { expect, it } from 'vitest'
import { verifyLearningCoreProof, verifyLearningCoreRows } from '../scripts/lib/inplace-learning-core-proof.mjs'
const names = ['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress']
it('verifies the actual four-fault rehearsal and its source manifest', async () => {
  expect(await verifyLearningCoreProof(new URL('../', import.meta.url))).toMatchObject({ files: 201, faultRecovered: true })
})
it('allows absent-to-empty initialization but rejects new data or changed prior rows', () => {
  const before = Object.fromEntries(names.map(name => [name, null]))
  const after = Object.fromEntries(names.map(name => [name, { rows: 0, sha256: 'empty' }]))
  expect(() => verifyLearningCoreRows(before, after)).not.toThrow()
  after.learning_progress.rows = 1
  expect(() => verifyLearningCoreRows(before, after)).toThrow('not_empty')
  const prior = structuredClone(after)
  after.learning_progress.sha256 = 'changed'
  expect(() => verifyLearningCoreRows(prior, after)).toThrow('rows_changed')
})
