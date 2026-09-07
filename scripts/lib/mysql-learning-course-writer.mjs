import { canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { learningCoreFieldContract } from './v4-learning-field-contract.mjs'
import { prepareLearningCourseRows } from './v4-learning-course-rows.mjs'

const sourceFields = learningCoreFieldContract().filter(field => field.sourceTable === 'courses').map(field => field.sourceField)
const integers = new Set(['id', 'episode_id', 'number', 'has_stream_video', 'quiz_count', 'knowledge_count', 'mindmap_count', 'structure_count', 'sort_order',
  'course_id', 'lesson_id', 'public_episode_id', 'display_number', 'duration_ms', 'revision'])
const sourceProjection = sourceFields.map(field => integers.has(field) ? `CAST(${field} AS CHAR) ${field}` : field).join(',')
const normalize = row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field,
  ['created_at', 'updated_at', 'created_at_utc', 'updated_at_utc', 'imported_at_utc'].includes(field) ? inspectWallClock(value).canonicalWallClock : value]))

// Three target tables, one caller-owned transaction. Never commits or retries a
// possibly applied insert. Media IDs are read by the stable unique lesson/kind key.
export function createLearningCourseWriter(sources, options) {
  const prepared = prepareLearningCourseRows(sources, options)
  const expected = new Map(prepared.entries.map(entry => [entry.sourceId, canonical(entry)]))
  return { prepared: structuredClone(prepared), async write(connection, entry, { verifyOnly = false } = {}) {
    check(expected.get(entry.sourceId) === canonical(entry), 'learning_course_writer_input')
    const [sources] = await connection.execute(`SELECT ${sourceProjection} FROM courses WHERE id=? FOR UPDATE`, [entry.sourceId])
    check(sources.length === 1 && canonical(normalize({ ...sources[0] })) === canonical(normalize(entry.provenance.source)), 'learning_course_writer_source')
    let inserted = 0
    const write = async (table, target, keys) => {
      const fields = Object.keys(target)
      const projection = [...(!fields.includes('id') ? ['CAST(id AS CHAR) id'] : []), ...fields.map(field => integers.has(field) ? `CAST(${field} AS CHAR) ${field}`
        : field.endsWith('_at_utc') ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field)].join(',')
      const read = async () => {
        const [rows] = await connection.execute(`SELECT ${projection} FROM ${table} WHERE ${keys.map(key => `${key}=?`).join(' AND ')} FOR UPDATE`, keys.map(key => target[key]))
        check(rows.length <= 1, 'learning_course_writer_duplicate')
        return rows.length ? normalize({ ...rows[0] }) : null
      }
      const matches = row => {
        const projected = Object.fromEntries(fields.map(field => [field, row[field]]))
        check(canonical(projected) === canonical(target), 'learning_course_writer_conflict')
        check(typeof row.id === 'string' && /^[1-9][0-9]*$/.test(row.id), 'learning_course_writer_target_id')
        return row.id
      }
      const current = await read()
      if (current) return matches(current)
      check(!verifyOnly, 'learning_course_writer_not_committed')
      await connection.execute(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(field => target[field]))
      inserted++
      const saved = await read()
      check(saved, 'learning_course_writer_readback_missing')
      return matches(saved)
    }
    const courseId = await write('learning_courses', entry.targets.course, ['id'])
    const lessonId = await write('learning_lessons', entry.targets.lesson, ['id'])
    const [existingMedia] = await connection.execute('SELECT source_kind FROM learning_media_references WHERE lesson_id=? FOR UPDATE', [lessonId])
    check(existingMedia.every(row => entry.targets.media.some(media => media.source_kind === row.source_kind)), 'learning_course_writer_unexpected_media')
    const media = []
    for (const target of entry.targets.media) media.push({ sourceKind: target.source_kind,
      id: await write('learning_media_references', target, ['lesson_id', 'source_kind']) })
    return { inserted, courseId, lessonId, media, targetHash: entry.targetHash }
  } }
}
