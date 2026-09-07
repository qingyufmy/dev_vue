import { beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { buildLearningManifest } from '../scripts/lib/v4-learning-manifest.mjs'
import { runLearningCommand } from '../scripts/lib/v4-learning-command.mjs'
import { readLearningCourseTargetIdentity } from '../scripts/lib/mysql-learning-course-backfill.mjs'
import { readLearningProgressTargetIdentity } from '../scripts/lib/mysql-learning-progress-backfill.mjs'
import { readLearningCourseAudit } from '../scripts/lib/mysql-learning-course-audit-reader.mjs'
import { readLearningProgressAudit } from '../scripts/lib/mysql-learning-progress-audit-reader.mjs'
import { executeLearningManifests } from '../scripts/lib/v4-learning-manifest-executor.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'

vi.mock('../scripts/lib/mysql-learning-course-backfill.mjs', () => ({ readLearningCourseTargetIdentity: vi.fn() }))
vi.mock('../scripts/lib/mysql-learning-progress-backfill.mjs', () => ({ readLearningProgressTargetIdentity: vi.fn() }))
vi.mock('../scripts/lib/mysql-learning-course-audit-reader.mjs', () => ({ readLearningCourseAudit: vi.fn() }))
vi.mock('../scripts/lib/mysql-learning-progress-audit-reader.mjs', () => ({ readLearningProgressAudit: vi.fn() }))
vi.mock('../scripts/lib/v4-learning-manifest-executor.mjs', () => ({ executeLearningManifests: vi.fn() }))
vi.mock('../scripts/lib/mysql-inplace-column-store.mjs', () => ({ withInplaceUpgradeLock: async (_connection, _database, work) => work() }))
beforeEach(() => vi.resetAllMocks())
function fixture(database = 'dev_vue') {
  const c = learningCourseFixture(), p = learningProgressFixture()
  p.options.run.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  p.options.lessonMappings[0].lessonSourceHash = hash(c.source)
  p.options.basis.lessonMappingHash = hash(p.options.lessonMappings)
  const identity = kind => ({ database, serverUuid: c.options.run.id, storageMode: `inplace-learning-${kind}-v1`, schemaHash: 'c'.repeat(64) })
  const manifest = (kind, f) => buildLearningManifest({ kind, sources: [f.source], options: f.options, logicalSourceId: 'fixture', mirrorDatabase: 'mirror',
    admission: { approved: true, blockers: [] }, targetIdentity: identity(kind === 'courses' ? 'course' : 'progress') })
  readLearningCourseTargetIdentity.mockResolvedValue(identity('course'))
  readLearningProgressTargetIdentity.mockResolvedValue(identity('progress'))
  readLearningCourseAudit.mockResolvedValue({ sources: [c.source] })
  readLearningProgressAudit.mockResolvedValue({ sources: [p.source], userIds: p.options.userIds })
  const connection = { query: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const input = { pool: { getConnection: vi.fn(async () => connection) }, database, expectedServerUuid: c.options.run.id,
    courseManifest: manifest('courses', c), progressManifest: manifest('progress', p), evidenceCatalog: c.options.evidenceCatalog, mode: 'check' }
  return { input, connection }
}
it('checks current rows and mappings in a read-only snapshot without migration writes', async () => {
  const f = fixture()
  expect(await runLearningCommand(f.input)).toEqual({ status: 'checked', sourceRows: { courses: 1, progress: 1 }, databaseWrites: 0 })
  expect(f.connection.query.mock.calls.at(-1)[0]).toBe('START TRANSACTION READ ONLY')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
  expect(executeLearningManifests).not.toHaveBeenCalled()
})
it('keeps dev_vue apply closed before connection until real rehearsal promotion', async () => {
  const f = fixture(); f.input.mode = 'apply'
  await expect(runLearningCommand(f.input)).rejects.toThrow('learning_entry_dev_vue_apply_requires_rehearsal')
  expect(f.input.pool.getConnection).not.toHaveBeenCalled()
})
it('forwards restored-copy apply after fresh identity, source and review checks', async () => {
  const f = fixture('dev_vue_m1_source_20260907_02'); f.input.mode = 'apply'
  executeLearningManifests.mockResolvedValue({ status: 'verified' })
  expect(await runLearningCommand(f.input)).toEqual({ status: 'verified' })
  expect(executeLearningManifests.mock.calls[0][0]).toMatchObject({ mode: 'apply', sources: { courses: [expect.objectContaining({ id: '12' })] } })
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('rejects identity drift and always releases the connection', async () => {
  const f = fixture()
  readLearningCourseTargetIdentity.mockResolvedValue({ database: 'other' })
  await expect(runLearningCommand(f.input)).rejects.toThrow('learning_entry_identity')
  expect(readLearningCourseAudit).not.toHaveBeenCalled()
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('rolls back the snapshot after reader failure and does not invoke migration', async () => {
  const f = fixture()
  readLearningProgressAudit.mockRejectedValue(new Error('read failed'))
  await expect(runLearningCommand(f.input)).rejects.toThrow('read failed')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.release).toHaveBeenCalledOnce()
  expect(executeLearningManifests).not.toHaveBeenCalled()
})
