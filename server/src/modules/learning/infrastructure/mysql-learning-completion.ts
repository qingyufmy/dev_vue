import { createHash } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { LearningError, type LearningMembershipReader } from '../domain/learning.js'
import { normalizeLearningCompletion, type LearningCompletionCommand, type LearningCompletionRepository, type LearningCompletionResult } from '../domain/learning-completion.js'

const utcText = (column: string) => `CONCAT(LEFT(DATE_FORMAT(${column},'%Y-%m-%dT%H:%i:%s.%f'),23),'Z')`
export function learningCompletionHash(command: LearningCompletionCommand) {
  return createHash('sha256').update(JSON.stringify(['learning-completion/v1', command.userId, command.requestId,
    command.courseId, command.lessonId, command.expectedRevision, command.completed])).digest('hex')
}
export class MysqlLearningCompletion implements LearningCompletionRepository {
  constructor(private readonly pool: Pick<Pool, 'getConnection'>,
    private readonly membershipForTransaction: (connection: PoolConnection) => LearningMembershipReader) {}

  async execute(input: LearningCompletionCommand): Promise<LearningCompletionResult> {
    const command = normalizeLearningCompletion(input), hash = learningCompletionHash(command)
    const connection = await this.pool.getConnection()
    let started = false, commitAttempted = false, destroyed = false
    try {
      await connection.query("SET SESSION time_zone='+00:00'")
      await connection.beginTransaction(); started = true
      // Serialize same-user create/update/replay; retain course and membership locks until commit.
      const [users] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [command.userId])
      if (users.length !== 1) throw new LearningError('learning_user_inactive', 403)
      const [courses] = await connection.execute<RowDataPacket[]>(
        "SELECT access_level FROM learning_courses WHERE id=? AND status='published' FOR SHARE", [command.courseId])
      if (courses.length !== 1) throw new LearningError('learning_course_not_found', 404)
      const [lessons] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM learning_lessons WHERE id=? AND course_id=? FOR SHARE', [command.lessonId, command.courseId])
      if (lessons.length !== 1) throw new LearningError('learning_lesson_not_found', 404)
      const [clock] = await connection.query<RowDataPacket[]>(`SELECT ${utcText('UTC_TIMESTAMP(3)')} now_utc`)
      const updatedAt = String(clock[0]?.now_utc)
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt)) throw Error('learning_clock_invalid')
      const plan = await this.membershipForTransaction(connection).activePlan(command.userId, new Date(updatedAt))
      const access = courses[0]!.access_level
      if (!(access === 'free' || access === 'logged_in' || access === 'plus_pro' && (plan === 'plus' || plan === 'pro')
        || access === 'pro_only' && plan === 'pro')) throw new LearningError('learning_membership_required', 403)
      const [receipts] = await connection.execute<RowDataPacket[]>(`SELECT request_sha256,CAST(lesson_id AS CHAR) lesson_id,
        completed,CAST(revision AS CHAR) revision,${utcText('recorded_at_utc')} updated_at
        FROM learning_progress_changes WHERE user_id=? AND request_id=? FOR UPDATE`, [command.userId, command.requestId])
      let result: LearningCompletionResult
      if (receipts.length) {
        const receipt = receipts[0]!
        if (receipts.length !== 1 || receipt.request_sha256 !== hash || receipt.lesson_id !== command.lessonId
          || receipt.revision !== (BigInt(command.expectedRevision) + 1n).toString()
          || Number(receipt.completed) !== Number(command.completed)) throw new LearningError('learning_idempotency_conflict', 409)
        result = { lesson_id: receipt.lesson_id, completed: command.completed, revision: receipt.revision,
          updated_at: receipt.updated_at, replayed: true }
      } else {
        const [progress] = await connection.execute<RowDataPacket[]>(`SELECT CAST(id AS CHAR) id,CAST(revision AS CHAR) revision,
          completed,updated_at_utc FROM learning_progress WHERE user_id=? AND lesson_id=? FOR UPDATE`, [command.userId, command.lessonId])
        if (progress.length > 1 || (progress[0]?.revision ?? '0') !== command.expectedRevision) throw new LearningError('learning_revision_conflict', 409)
        const revision = (BigInt(command.expectedRevision) + 1n).toString(), atSql = updatedAt.replace('T', ' ').slice(0, -1)
        const previous = progress[0]
        let progressId: string
        if (previous) {
          progressId = previous.id
          const [updated] = await connection.execute<ResultSetHeader>(`UPDATE learning_progress SET completed=?,revision=?,updated_at_utc=?
            WHERE id=? AND user_id=? AND lesson_id=? AND revision=?`,
          [Number(command.completed), revision, atSql, progressId, command.userId, command.lessonId, command.expectedRevision])
          if (updated.affectedRows !== 1) throw new LearningError('learning_revision_conflict', 409)
        } else {
          const [created] = await connection.execute<ResultSetHeader>(`INSERT INTO learning_progress
            (user_id,lesson_id,completed,updated_at_utc,revision,origin) VALUES (?,?,?,?,1,'native')`,
          [command.userId, command.lessonId, Number(command.completed), atSql])
          if (created.affectedRows !== 1 || !Number.isSafeInteger(created.insertId) || created.insertId < 1) throw Error('learning_insert_invalid')
          progressId = String(created.insertId)
        }
        await connection.execute(`INSERT INTO learning_progress_changes
          (user_id,request_id,request_sha256,course_id,lesson_id,prior_revision,revision,prior_completed,completed,prior_updated_at_utc,recorded_at_utc)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [command.userId, command.requestId, hash, command.courseId, command.lessonId,
          command.expectedRevision, revision, previous?.completed ?? null, Number(command.completed), previous?.updated_at_utc ?? null, atSql])
        result = { lesson_id: command.lessonId, completed: command.completed, revision, updated_at: updatedAt, replayed: false }
      }
      commitAttempted = true; await connection.commit()
      return result
    } catch (error) {
      if (commitAttempted) { connection.destroy(); destroyed = true; throw new LearningError('learning_commit_unknown', 503) }
      if (started) {
        try { await connection.rollback() }
        catch { connection.destroy(); destroyed = true; throw new LearningError('learning_rollback_unknown', 503) }
      }
      if (error instanceof LearningError) throw error
      throw new LearningError('learning_write_failed', 503)
    } finally { if (!destroyed) connection.release() }
  }
}
