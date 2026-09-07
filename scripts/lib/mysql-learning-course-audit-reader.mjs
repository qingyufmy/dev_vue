import { streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { learningCoreFieldContract } from './v4-learning-field-contract.mjs'
import { learningCourseAuditFields } from './v4-learning-course-audit.mjs'

const sourceFields = learningCoreFieldContract().filter(field => field.sourceTable === 'courses').map(field => field.sourceField)
const integerFields = new Set(['id', 'episode_id', 'number', 'has_stream_video', 'quiz_count', 'knowledge_count', 'mindmap_count', 'structure_count',
  'sort_order', 'course_id', 'public_episode_id', 'display_number', 'duration_ms', 'lesson_id', 'revision'])
const projection = fields => fields.map(field => integerFields.has(field) ? `CAST(${field} AS CHAR) ${field}`
  : field.endsWith('_at_utc') ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}`
    : ['created_at', 'updated_at'].includes(field) ? `CAST(${field} AS CHAR) ${field}` : field).join(',')

// Read in a fresh REPEATABLE READ transaction. The field lists and table names
// come only from the fixed learning schema, never from caller-supplied strings.
export async function readLearningCourseAudit(connection, runId) {
  check(typeof runId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId), 'learning_course_audit_run')
  const [sources] = await connection.execute(`SELECT ${projection(sourceFields)} FROM courses ORDER BY id`)
  const [courses] = await connection.execute(`SELECT ${projection(learningCourseAuditFields.courses)} FROM learning_courses WHERE migration_run_id=? ORDER BY id`, [runId])
  const [lessons] = await connection.execute(`SELECT ${projection(learningCourseAuditFields.lessons)} FROM learning_lessons
    WHERE migration_run_id=? OR course_id IN (SELECT id FROM learning_courses WHERE migration_run_id=?) ORDER BY id`, [runId, runId])
  const [media] = await connection.execute(`SELECT ${projection(learningCourseAuditFields.media)} FROM learning_media_references
    WHERE migration_run_id=? OR lesson_id IN (SELECT id FROM learning_lessons WHERE migration_run_id=?
      OR course_id IN (SELECT id FROM learning_courses WHERE migration_run_id=?)) ORDER BY id`, [runId, runId, runId])
  const stream = streamIdentity({ sourceTable: 'courses', role: 'learning-course-v1' })
  const [archiveRows] = await connection.execute(`SELECT run_id,source_pk_sha256,source_bytes_sha256,source_payload_json
    FROM data_migration_source_rows WHERE run_id=? AND stream_id=? ORDER BY source_pk_sha256`, [runId, stream])
  const archives = archiveRows.map(row => {
    let payload
    try { payload = typeof row.source_payload_json === 'string' ? JSON.parse(row.source_payload_json) : row.source_payload_json }
    catch { check(false, 'learning_course_archive_json') }
    check(payload && typeof payload.source?.id === 'string', 'learning_course_archive_source')
    return { sourceId: payload.source.id, runId: row.run_id, sourceHash: row.source_bytes_sha256, sourcePkHash: row.source_pk_sha256, payload }
  })
  return { sources, actual: { courses, lessons, media }, archives }
}
