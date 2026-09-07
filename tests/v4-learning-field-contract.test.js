import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { learningCoreFieldContract } from '../scripts/lib/v4-learning-field-contract.mjs'
import { splitSqlStatements } from '../scripts/lib/v4-migration-plan.mjs'

it('accounts for every observed course and progress field exactly once', async () => {
  const inventory = JSON.parse(await readFile(new URL('../docs/migration/dev-vue-learning-inventory-20260907.json', import.meta.url), 'utf8'))
  const observed = inventory.entries.filter(entry => ['courses', 'progress'].includes(entry.table))
    .flatMap(entry => entry.columns.map(column => `${entry.table}.${column.name}`)).sort()
  const actual = learningCoreFieldContract().map(field => `${field.sourceTable}.${field.sourceField}`).sort()
  expect(actual).toEqual(observed)
  expect(new Set(actual).size).toBe(34)
})
it('keeps the additive core separate from legacy tables and preserves over-duration progress', async () => {
  const sql = await readFile(new URL('../server/db/migrations/inplace/022_learning_core.sql', import.meta.url), 'utf8')
  const statements = splitSqlStatements(sql)
  expect(statements.map(statement => /^CREATE TABLE ([a-z_]+)/.exec(statement)?.[1]))
    .toEqual(['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress'])
  expect(sql).not.toMatch(/ON DELETE CASCADE|DROP TABLE|ALTER TABLE/)
  expect(sql).not.toMatch(/watched_ms\s*<=\s*reported_duration_ms/)
  expect(sql).toContain('UNIQUE KEY uk_learning_progress_user_lesson (user_id,lesson_id)')
})
