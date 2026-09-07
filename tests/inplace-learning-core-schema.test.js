import { expect, it } from 'vitest'
import { loadLearningCoreCoordinator } from '../scripts/lib/inplace-learning-core-schema.mjs'
import { loadSettingRequestCoordinator } from '../scripts/lib/inplace-setting-request-schema.mjs'
const root = new URL('../', import.meta.url)
it('extends the exact previous 58 steps without changing their identities or checksums', async () => {
  const prior = await loadSettingRequestCoordinator(root), next = await loadLearningCoreCoordinator(root)
  expect(next.steps).toHaveLength(62)
  expect(next.steps.slice(0, 58)).toEqual(prior.steps)
  expect(next.steps.slice(58).map(step => step.table)).toEqual(['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress'])
  expect(next.steps.slice(58).every(step => step.beforeHash === null && step.afterHash.length === 64)).toBe(true)
})
it('refuses replacing an existing view or a table with triggers', async () => {
  const plan = await loadLearningCoreCoordinator(root)
  const view = { execute: async () => [[{ type: 'VIEW' }]] }
  await expect(plan.store(view).tableHash('learning_courses')).rejects.toThrow('table_conflict')
  const trigger = { execute: async sql => sql.includes('TABLES') ? [[{ type: 'BASE TABLE' }]] : [[{ name: 'unexpected' }]] }
  await expect(plan.store(trigger).tableHash('learning_courses')).rejects.toThrow('trigger_conflict')
})
