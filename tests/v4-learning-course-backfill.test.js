import { expect, it, vi } from 'vitest'
import { canonical, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { createLearningCourseBackfill } from '../scripts/lib/v4-learning-course-backfill.mjs'
import { MysqlLearningCourseBackfillRepository } from '../scripts/lib/mysql-learning-course-backfill.mjs'
import { auditLearningCourseImport } from '../scripts/lib/v4-learning-course-audit.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'

function fixture() {
  const { source, options } = learningCourseFixture(), pipeline = createLearningCourseBackfill([source], options)
  const row = pipeline.batches[0].rows[0], stream = streamIdentity(pipeline.stream)
  const { course, lesson, media } = structuredClone(row.payload.entry.targets)
  const tables = { learning_courses: [course], learning_lessons: [lesson],
    learning_media_references: media.map((item, index) => ({ id: String(9007199254740993n + BigInt(index)), ...item })) }
  let archived = null
  const connection = { query: vi.fn(async () => [[]]), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql, args) => {
      if (sql.startsWith('INSERT INTO data_migration_source_rows')) {
        archived = { runId: args[0], sourcePkHash: args[2], sourceHash: args[3], payload: JSON.parse(args[4]), sourceId: source.id }
        return [{ affectedRows: 1 }]
      }
      if (sql.startsWith('INSERT INTO data_migration_row_receipts')) return [{ affectedRows: 1 }]
      if (sql.startsWith('SELECT source_bytes_sha256')) return [[{ source_bytes_sha256: archived.sourceHash, source_payload_json: canonical(archived.payload) }]]
      if (sql.includes('FROM courses WHERE')) return [[structuredClone(source)]]
      const table = /FROM (learning_\w+)/.exec(sql)?.[1]
      if (!table) throw new Error('unexpected SQL')
      const records = tables[table]
      if (sql.startsWith('SELECT source_kind')) return [records.map(item => ({ source_kind: item.source_kind }))]
      if (table === 'learning_media_references') return [structuredClone(records.filter(item => item.lesson_id === args[0] && item.source_kind === args[1]))]
      return [structuredClone(records.filter(item => item.id === args[0]))]
    }) }
  const repository = new MysqlLearningCourseBackfillRepository({ getConnection: async () => connection }, pipeline.sourceEvidence)
  const write = tx => tx.insertReceipt(pipeline.runId, stream, pipeline.batches[0].batchId, row)
  return { source, options, pipeline, row, stream, tables, connection, repository, write, archive: () => archived }
}
it('archives full source and freshly verified generated media IDs before transaction commit', async () => {
  const f = fixture()
  await f.repository.transaction(f.write)
  expect(f.archive().payload.mediaBindings).toEqual([{ sourceKind: 'bilibili_id', id: '9007199254740993' }, { sourceKind: 'article_url', id: '9007199254740994' }])
  const actual = { courses: f.tables.learning_courses, lessons: f.tables.learning_lessons, media: f.tables.learning_media_references }
  expect(auditLearningCourseImport([f.source], actual, [f.archive()], f.options).importMatchesReviewedInputs).toBe(true)
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT')).map(([sql]) => sql.split(' ')[2]))
    .toEqual(['data_migration_row_receipts', 'data_migration_source_rows'])
  expect(f.row.targets.map(target => target.table)).toEqual(['learning_courses', 'learning_lessons'])
})
it('never fills missing media while creating source evidence, and rolls back before receipts', async () => {
  const f = fixture()
  f.tables.learning_media_references.pop()
  await expect(f.repository.transaction(f.write)).rejects.toThrow('learning_course_writer_not_committed')
  expect(f.connection.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
})
it('detects changed media content and closed-batch tampering before evidence insertion', async () => {
  const f = fixture()
  f.tables.learning_media_references[0].locator = 'changed'
  await expect(f.repository.transaction(f.write)).rejects.toThrow('learning_course_writer_conflict')
  const changed = fixture()
  changed.row.payload.entry.targets.lesson.public_episode_id = '101'
  await expect(changed.pipeline.sourceEvidence(changed.connection, changed.stream, changed.row)).rejects.toThrow('learning_course_batch_row_changed')
  expect(changed.connection.execute).not.toHaveBeenCalled()
})
it('requires the exact stream and run, and does not leak mutable source evidence', async () => {
  const f = fixture()
  await expect(f.pipeline.sourceEvidence(f.connection, 'other', f.row)).rejects.toThrow('learning_course_evidence_stream')
  await expect(f.repository.transaction(tx => tx.insertReceipt('other', f.stream, 'batch', f.row))).rejects.toThrow('backfill_learning_run_mismatch')
  expect(f.connection.execute).not.toHaveBeenCalled()
  const evidence = await f.pipeline.sourceEvidence(f.connection, f.stream, f.row)
  evidence.source.title = 'changed'
  expect((await f.pipeline.sourceEvidence(f.connection, f.stream, f.row)).source.title).toBe('fixture-title')
})
