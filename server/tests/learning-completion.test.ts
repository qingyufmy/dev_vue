import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { normalizeLearningCompletion, type LearningCompletionCommand } from '../src/modules/learning/domain/learning-completion.js'
import { MysqlLearningCompletion } from '../src/modules/learning/infrastructure/mysql-learning-completion.js'
import { MysqlLearningMembershipReader } from '../src/modules/commerce/infrastructure/mysql-learning-membership-reader.js'

const command: LearningCompletionCommand = { userId: 7, courseId: '12', lessonId: '99',
  requestId: 'a56a2134-9105-4e93-a806-bb3793f7ad38', expectedRevision: '9007199254740993', completed: true }
function fixture() {
  const state = {
    progress: { id: '5', revision: command.expectedRevision, completed: null as number | null,
      updated_at_utc: null as string | null, watched_ms: '9007199254740993', reported_duration_ms: '5000',
      quiz_passed: 0, origin: 'legacy_import', source_sha256: 'f'.repeat(64) } as Record<string, unknown> | null,
    receipts: [] as Record<string, unknown>[], active: true, lesson: true, access: 'logged_in', failAudit: false,
  }
  let before = structuredClone(state)
  const execute = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.startsWith('SELECT id FROM users')) return [state.active ? [{ id: 7 }] : []]
    if (sql.startsWith('SELECT access_level')) return [[{ access_level: state.access }]]
    if (sql.startsWith('SELECT id FROM learning_lessons')) return [state.lesson ? [{ id: 99 }] : []]
    if (sql.includes('FROM learning_progress_changes')) return [structuredClone(state.receipts.filter(row => row.user_id === values[0] && row.request_id === values[1]))]
    if (sql.includes('FROM learning_progress WHERE')) return [[...(state.progress ? [structuredClone(state.progress)] : [])]]
    if (sql.startsWith('UPDATE learning_progress SET')) {
      Object.assign(state.progress!, { completed: values[0], revision: values[1], updated_at_utc: values[2] })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('INSERT INTO learning_progress_changes')) {
      if (state.failAudit) throw Error('private sql details')
      state.receipts.push({ user_id: values[0], request_id: values[1], request_sha256: values[2], lesson_id: values[4], revision: values[6],
        completed: values[8], updated_at: '2026-09-07T12:30:00.123Z' })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('INSERT INTO learning_progress')) {
      state.progress = { id: '6', revision: '1', completed: values[2], updated_at_utc: values[3], origin: 'native',
        watched_ms: null, reported_duration_ms: null, quiz_passed: null }
      return [{ affectedRows: 1, insertId: 6 }]
    }
    throw Error('unexpected fixture query')
  })
  const connection = {
    execute, query: vi.fn(async (sql: string) => sql.startsWith('SELECT') ? [[{ now_utc: '2026-09-07T12:30:00.123Z' }]] : []),
    beginTransaction: vi.fn(async () => { before = structuredClone(state) }),
    commit: vi.fn(async () => {}), rollback: vi.fn(async () => { Object.assign(state, structuredClone(before)) }),
    destroy: vi.fn(), release: vi.fn(),
  }
  const memberships = { activePlan: vi.fn(async (): Promise<'free' | 'plus' | 'pro'> => 'free') }
  const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pick<Pool, 'getConnection'>
  const repository = new MysqlLearningCompletion(pool, () => memberships)
  return { state, connection, memberships, repository }
}

describe('learning completion command', () => {
  it('keeps exact revisions and rejects client-controlled fields, coercions and overflow', () => {
    expect(normalizeLearningCompletion(command)).toEqual(command)
    for (const patch of [{ expectedRevision: '18446744073709551615' }, { expectedRevision: '1\n' }, { expectedRevision: '01' },
      { lessonId: '1\n' }, { courseId: '2147483648' }, { completed: 1 }, { watched_ms: '1' }, { userId: 0 },
      { requestId: command.requestId + '\n' }]) {
      expect(() => normalizeLearningCompletion({ ...command, ...patch } as LearningCompletionCommand)).toThrow('learning_completion_invalid')
    }
  })
  it('changes only completion/version/time and audits the original state', async () => {
    const f = fixture(), before = structuredClone(f.state.progress)
    const result = await f.repository.execute(command)
    expect(result).toEqual({ lesson_id: '99', completed: true, revision: '9007199254740994', updated_at: '2026-09-07T12:30:00.123Z', replayed: false })
    expect(f.state.progress).toEqual({ ...before, completed: 1, revision: result.revision, updated_at_utc: '2026-09-07 12:30:00.123' })
    const audit = f.connection.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO learning_progress_changes'))!
    expect(audit[1].slice(5)).toEqual([command.expectedRevision, result.revision, null, 1, null, '2026-09-07 12:30:00.123'])
    expect(f.connection.commit).toHaveBeenCalledOnce()
  })
  it('creates a native completion without inventing duration or quiz progress', async () => {
    const f = fixture(); f.state.progress = null
    const result = await f.repository.execute({ ...command, expectedRevision: '0' })
    expect(result.revision).toBe('1')
    expect(f.state.progress).toMatchObject({ origin: 'native', watched_ms: null, reported_duration_ms: null, quiz_passed: null })
  })
  it('replays the original receipt even when a later update exists', async () => {
    const f = fixture(), first = await f.repository.execute(command)
    f.state.progress!.revision = '9007199254740995'; f.state.progress!.completed = 0
    expect(await f.repository.execute(command)).toEqual({ ...first, replayed: true })
    expect(f.state.progress!.completed).toBe(0)
    expect(f.state.receipts).toHaveLength(1)
  })
  it('rejects a reused key with another payload and rejects stale versions', async () => {
    const f = fixture(); await f.repository.execute(command)
    await expect(f.repository.execute({ ...command, completed: false })).rejects.toMatchObject({ code: 'learning_idempotency_conflict', status: 409 })
    await expect(f.repository.execute({ ...command, requestId: 'b' + command.requestId.slice(1) })).rejects.toMatchObject({ code: 'learning_revision_conflict', status: 409 })
    expect(f.state.receipts).toHaveLength(1)
  })
  it('reauthorizes replays before reading receipts', async () => {
    const f = fixture(); await f.repository.execute(command); f.state.access = 'pro_only'
    f.connection.execute.mockClear()
    await expect(f.repository.execute(command)).rejects.toMatchObject({ code: 'learning_membership_required', status: 403 })
    expect(f.connection.execute.mock.calls.some(([sql]) => sql.includes('FROM learning_progress_changes'))).toBe(false)
  })
  it('rejects inactive users and lessons outside the given course', async () => {
    const f = fixture(); f.state.active = false
    await expect(f.repository.execute(command)).rejects.toMatchObject({ code: 'learning_user_inactive' })
    f.state.active = true; f.state.lesson = false
    await expect(f.repository.execute(command)).rejects.toMatchObject({ code: 'learning_lesson_not_found' })
    expect(f.state.receipts).toHaveLength(0)
  })
  it('rolls back progress when its audit insert fails and sanitizes the failure', async () => {
    const f = fixture(), before = structuredClone(f.state.progress); f.state.failAudit = true
    await expect(f.repository.execute(command)).rejects.toMatchObject({ code: 'learning_write_failed', status: 503 })
    expect(f.state.progress).toEqual(before); expect(f.state.receipts).toHaveLength(0)
    expect(f.connection.commit).not.toHaveBeenCalled()
  })
  it('does not roll back or release a connection after lost commit acknowledgement; same key recovers', async () => {
    const f = fixture(); f.connection.commit.mockRejectedValueOnce(Error('ack lost'))
    await expect(f.repository.execute(command)).rejects.toMatchObject({ code: 'learning_commit_unknown', status: 503 })
    expect(f.connection.rollback).not.toHaveBeenCalled(); expect(f.connection.release).not.toHaveBeenCalled()
    expect(f.connection.destroy).toHaveBeenCalledOnce()
    expect((await f.repository.execute(command)).replayed).toBe(true)
    expect(f.state.receipts).toHaveLength(1)
  })
  it('destroys a connection if rollback cannot be confirmed', async () => {
    const f = fixture(); f.state.failAudit = true; f.connection.rollback.mockRejectedValueOnce(Error('rollback lost'))
    await expect(f.repository.execute(command)).rejects.toMatchObject({ code: 'learning_rollback_unknown', status: 503 })
    expect(f.connection.destroy).toHaveBeenCalledOnce(); expect(f.connection.release).not.toHaveBeenCalled()
  })
  it('locks membership through the commerce transaction adapter', async () => {
    const execute = vi.fn(async (_sql: string, _params: unknown[]) => [[{ plan_code: 'pro' }]])
    const membership = MysqlLearningMembershipReader.forTransaction({ execute } as unknown as PoolConnection)
    expect(await membership.activePlan(7, new Date('2026-09-07T00:00:00Z'))).toBe('pro')
    expect(execute.mock.calls[0]![0]).toContain('FOR SHARE')
  })
})
