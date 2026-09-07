import { streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'

// Caller owns a fresh consistent-read transaction after migration commit. These
// queries never reuse converter output as target evidence and never mutate rows.
export async function readLearningProgressAudit(connection, runId) {
  check(typeof runId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId), 'learning_progress_audit_run')
  const [sources] = await connection.execute(`SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) user_id,CAST(episode_id AS CHAR) episode_id,
    CAST(watched_seconds AS CHAR) watched_seconds,CAST(total_duration AS CHAR) total_duration,CAST(completed AS CHAR) completed,
    CAST(quiz_passed AS CHAR) quiz_passed,CAST(updated_at AS CHAR) updated_at FROM progress ORDER BY id`)
  const [actual] = await connection.execute(`SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) user_id,CAST(lesson_id AS CHAR) lesson_id,
    CAST(watched_ms AS CHAR) watched_ms,CAST(reported_duration_ms AS CHAR) reported_duration_ms,CAST(completed AS CHAR) completed,
    CAST(quiz_passed AS CHAR) quiz_passed,DATE_FORMAT(updated_at_utc,'%Y-%m-%d %H:%i:%s.%f') updated_at_utc,
    CAST(revision AS CHAR) revision,origin,migration_run_id,source_sha256,DATE_FORMAT(imported_at_utc,'%Y-%m-%d %H:%i:%s.%f') imported_at_utc
    FROM learning_progress WHERE migration_run_id=? ORDER BY id`, [runId])
  const stream = streamIdentity({ sourceTable: 'progress', role: 'learning-progress-v1' })
  const [archiveRows] = await connection.execute(`SELECT run_id,source_pk_sha256,source_bytes_sha256,source_payload_json
    FROM data_migration_source_rows WHERE run_id=? AND stream_id=? ORDER BY source_pk_sha256`, [runId, stream])
  const archives = archiveRows.map(row => {
    let payload
    try { payload = typeof row.source_payload_json === 'string' ? JSON.parse(row.source_payload_json) : row.source_payload_json }
    catch { check(false, 'learning_progress_archive_json') }
    check(payload && typeof payload.source?.id === 'string', 'learning_progress_archive_source')
    return { sourceId: payload.source.id, runId: row.run_id, sourceHash: row.source_bytes_sha256, sourcePkHash: row.source_pk_sha256, payload }
  })
  const [actualLessons] = await connection.execute(`SELECT CAST(l.id AS CHAR) id,CAST(l.public_episode_id AS CHAR) public_episode_id,l.source_sha256
    FROM learning_lessons l WHERE EXISTS (SELECT 1 FROM progress p WHERE p.episode_id=l.public_episode_id)
      OR EXISTS (SELECT 1 FROM learning_progress p WHERE p.lesson_id=l.id AND p.migration_run_id=?) ORDER BY l.id`, [runId])
  const [users] = await connection.execute(`SELECT CAST(u.id AS CHAR) id FROM users u
    WHERE EXISTS (SELECT 1 FROM progress p WHERE p.user_id=u.id)
      OR EXISTS (SELECT 1 FROM learning_progress p WHERE p.user_id=u.id AND p.migration_run_id=?) ORDER BY u.id`, [runId])
  return { sources, actual, archives, actualLessons, userIds: new Set(users.map(row => row.id)) }
}
