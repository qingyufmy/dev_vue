import { canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { prepareLearningProgressRows } from './v4-learning-progress-rows.mjs'

export const learningProgressTargetFields = Object.freeze(['id', 'user_id', 'lesson_id', 'watched_ms', 'reported_duration_ms', 'completed', 'quiz_passed', 'updated_at_utc', 'revision', 'origin', 'migration_run_id', 'source_sha256', 'imported_at_utc'])
const numeric = new Set(['id', 'user_id', 'lesson_id', 'watched_ms', 'reported_duration_ms', 'completed', 'quiz_passed', 'revision'])
const projection = learningProgressTargetFields.map(field => numeric.has(field) ? `CAST(${field} AS CHAR) ${field}`
  : field.endsWith('_at_utc') ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field).join(',')
const sourceProjection = 'CAST(id AS CHAR) id,CAST(user_id AS CHAR) user_id,CAST(episode_id AS CHAR) episode_id,CAST(watched_seconds AS CHAR) watched_seconds,CAST(total_duration AS CHAR) total_duration,CAST(completed AS CHAR) completed,CAST(quiz_passed AS CHAR) quiz_passed,updated_at'
const sourceValue = source => ({ ...source, updated_at: inspectWallClock(source.updated_at).canonicalWallClock })

// Caller owns transaction, run/checkpoint locks and commit outcome. No implicit
// updates, commits, receipts, grants or completion-state recalculation here.
export function createLearningProgressWriter(sources, options) {
  const prepared = prepareLearningProgressRows(sources, options)
  const expected = new Map(prepared.entries.map(entry => [entry.sourceId, canonical(entry)]))
  return { prepared: structuredClone(prepared), async write(connection, entry, { verifyOnly = false } = {}) {
    check(expected.get(entry.sourceId) === canonical(entry), 'learning_progress_writer_input')
    const [users] = await connection.execute('SELECT CAST(id AS CHAR) id FROM users WHERE id=? FOR UPDATE', [entry.target.user_id])
    check(users.length === 1 && users[0].id === entry.target.user_id, 'learning_progress_writer_user')
    const [lessons] = await connection.execute('SELECT CAST(id AS CHAR) id,CAST(public_episode_id AS CHAR) episodeId,source_sha256 sourceHash FROM learning_lessons WHERE id=? FOR UPDATE', [entry.target.lesson_id])
    const mapping = entry.provenance.lessonMapping
    check(lessons.length === 1 && lessons[0].id === mapping.lessonId && lessons[0].episodeId === mapping.episodeId
      && lessons[0].sourceHash === mapping.lessonSourceHash, 'learning_progress_writer_lesson')
    const [rows] = await connection.execute(`SELECT ${sourceProjection} FROM progress WHERE id=? FOR UPDATE`, [entry.sourceId])
    check(rows.length === 1 && canonical(sourceValue({ ...rows[0] })) === canonical(sourceValue(entry.provenance.source)), 'learning_progress_writer_source')
    const read = async () => {
      const [saved] = await connection.execute(`SELECT ${projection} FROM learning_progress WHERE id=? FOR UPDATE`, [entry.target.id])
      check(saved.length <= 1, 'learning_progress_writer_duplicate')
      if (!saved.length) return null
      return { ...saved[0], updated_at_utc: inspectWallClock(saved[0].updated_at_utc).canonicalWallClock,
        imported_at_utc: inspectWallClock(saved[0].imported_at_utc).canonicalWallClock }
    }
    const current = await read()
    if (current) {
      check(canonical(current) === canonical(entry.target), 'learning_progress_writer_target_conflict')
      return { applied: false, targetHash: entry.targetHash }
    }
    check(!verifyOnly, 'learning_progress_writer_not_committed')
    await connection.execute(`INSERT INTO learning_progress (${learningProgressTargetFields.join(',')}) VALUES (${learningProgressTargetFields.map(() => '?').join(',')})`, learningProgressTargetFields.map(field => entry.target[field]))
    check(canonical(await read()) === canonical(entry.target), 'learning_progress_writer_readback')
    return { applied: true, targetHash: entry.targetHash }
  } }
}
