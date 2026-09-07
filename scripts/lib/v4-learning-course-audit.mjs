import { canonical, exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { learningCoreFieldContract } from './v4-learning-field-contract.mjs'

const commonFields = ['created_at_utc', 'updated_at_utc', 'revision', 'origin', 'migration_run_id', 'source_sha256', 'imported_at_utc']
export const learningCourseAuditFields = Object.freeze({
  courses: ['id', 'title', 'description', 'category_key', 'cover_locator', 'gradient_token', 'access_level', 'status', 'sort_order', ...commonFields],
  lessons: ['id', 'course_id', 'public_episode_id', 'display_number', 'title', 'content_type', 'duration_ms', 'sort_order', ...commonFields],
  media: ['id', 'lesson_id', 'source_kind', 'locator', ...commonFields],
})
const mediaKinds = ['youtube_id', 'bilibili_id', 'cf_stream_id', 'local_video_path', 'article_url', 'article_object_key']
const sourceFields = learningCoreFieldContract().filter(field => field.sourceTable === 'courses').map(field => field.sourceField)
const unique = (rows, key) => {
  const result = new Map()
  for (const row of rows) {
    check(typeof row[key] === 'string' && !result.has(row[key]), 'learning_course_audit_duplicate')
    result.set(row[key], row)
  }
  return result
}
const positiveId = (value, maximum) => check(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= maximum, 'learning_course_audit_id')
const milliseconds = value => {
  if (value === null) return null
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value), 'learning_course_audit_duration')
  const [whole, fraction = ''] = value.split('.')
  check(!/[1-9]/.test(fraction.slice(3)), 'learning_course_audit_precision')
  const result = BigInt(whole) * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, '0'))
  check(result <= 9223372036854775807n, 'learning_course_audit_duration_range')
  return String(result)
}

// Independently reconstruct expected values from reviewed source evidence. The
// converter and writer are deliberately not dependencies of this auditor.
export function auditLearningCourseImport(sources, actual, archives, { run, basis, evidenceCatalog }) {
  exactKeys(actual, ['courses', 'lessons', 'media'])
  check([sources, archives, ...Object.values(actual)].every(Array.isArray) && evidenceCatalog instanceof Map, 'learning_course_audit_input')
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'learning_course_audit_run')
  const registered = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  for (const source of sources) { exactKeys(source, sourceFields); positiveId(source.id, 2147483647n); positiveId(source.episode_id, 2147483647n) }
  unique(sources, 'id'); unique(sources, 'episode_id')
  const sorted = [...sources].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'resolutions'])
  check(basis.version === 'learning-course-import/v1' && basis.sourceHash === hash(sorted) && basis.sourceSnapshotId === run.sourceSnapshotId
    && Array.isArray(basis.resolutions) && basis.resolutions.length === sources.length, 'learning_course_audit_basis')
  const resolutions = unique(basis.resolutions, 'sourceId'), saved = unique(archives, 'sourceId')
  const tables = Object.fromEntries(Object.entries(actual).map(([table, rows]) => [table, unique(rows, 'id')]))
  const mediaByKey = new Map(), differences = []
  for (const row of actual.media) {
    positiveId(row.id, 18446744073709551615n)
    const key = canonical([row.lesson_id, row.source_kind])
    check(!mediaByKey.has(key), 'learning_course_audit_media_duplicate')
    mediaByKey.set(key, row)
  }
  const add = (sourceId, field, code) => differences.push({ sourceId, field, code })
  const proof = item => check(typeof item.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.evidenceId)
    && typeof item.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.evidenceSha256)
    && evidenceCatalog.get(item.evidenceId) === item.evidenceSha256, 'learning_course_audit_evidence')
  const utc = (raw, rule) => {
    exactKeys(rule, ['raw', 'kind', 'offsetMinutes', 'evidenceId', 'evidenceSha256']); proof(rule)
    check(rule.raw === raw, 'learning_course_audit_time_binding')
    if (raw === null) { check(rule.kind === 'source_null' && rule.offsetMinutes === null, 'learning_course_audit_null_time'); return null }
    check(rule.kind === 'wall_clock' && Number.isInteger(rule.offsetMinutes) && Math.abs(rule.offsetMinutes) <= 840, 'learning_course_audit_offset')
    const date = new Date(Date.parse(inspectWallClock(raw).canonicalWallClock.replace(' ', 'T') + 'Z') - rule.offsetMinutes * 60000)
    check(date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999, 'learning_course_audit_time_range')
    return date.toISOString().replace('T', ' ').slice(0, -1)
  }
  const compare = (sourceId, table, expected, row) => {
    if (!row) { add(sourceId, table, 'missing'); return }
    exactKeys(row, learningCourseAuditFields[table])
    for (const field of learningCourseAuditFields[table]) {
      const value = field.endsWith('_at_utc') ? inspectWallClock(row[field]).canonicalWallClock : row[field]
      if (value !== expected[field]) add(sourceId, `${table}.${field}`, 'value_mismatch')
    }
    tables[table].delete(row.id)
  }
  for (const source of sorted) {
    const id = source.id, sourceHash = hash(source), resolution = resolutions.get(id)
    check(resolution?.sourceHash === sourceHash, 'learning_course_audit_binding')
    exactKeys(resolution, ['sourceId', 'sourceHash', 'createdAt', 'updatedAt', 'valueEvidence'])
    exactKeys(resolution.valueEvidence, ['evidenceId', 'evidenceSha256', 'requirements']); proof(resolution.valueEvidence)
    check(Array.isArray(resolution.valueEvidence.requirements) && canonical([...resolution.valueEvidence.requirements].sort())
      === canonical(['access_review', 'duration_seconds', 'media_reference_review', 'projection_archive_review']), 'learning_course_audit_semantics')
    check([null, 'free', 'logged_in', 'plus_pro', 'pro_only'].includes(source.access_level)
      && [null, 'draft', 'published', 'archived'].includes(source.status) && [null, 'video', 'article'].includes(source.content_type), 'learning_course_audit_enum')
    const common = { created_at_utc: utc(source.created_at, resolution.createdAt), updated_at_utc: utc(source.updated_at, resolution.updatedAt),
      revision: '1', origin: 'legacy_import', migration_run_id: run.id, source_sha256: sourceHash, imported_at_utc: registered }
    compare(id, 'courses', { id, title: source.title, description: source.description, category_key: source.category, cover_locator: source.cover,
      gradient_token: source.gradient, access_level: source.access_level, status: source.status, sort_order: source.sort_order, ...common }, tables.courses.get(id))
    compare(id, 'lessons', { id, course_id: id, public_episode_id: source.episode_id, display_number: source.number, title: source.title,
      content_type: source.content_type, duration_ms: milliseconds(source.duration), sort_order: '0', ...common }, tables.lessons.get(id))
    const archive = saved.get(id), bindings = archive?.payload?.mediaBindings
    if (!archive) add(id, 'archive', 'missing')
    else {
      if (archive.runId !== run.id || archive.sourceHash !== sourceHash || archive.sourcePkHash !== hash([{ type: 'integer', value: id }])) add(id, 'archive', 'identity_mismatch')
      check(Array.isArray(bindings), 'learning_course_audit_media_bindings')
      unique(bindings, 'sourceKind'); unique(bindings, 'id')
      for (const binding of bindings) { exactKeys(binding, ['sourceKind', 'id']); positiveId(binding.id, 18446744073709551615n) }
      const payload = { version: 1, sourceTable: 'courses', projection: 'learning-course-source/v1', source, sourceSnapshotId: run.sourceSnapshotId,
        registeredAtUtc: run.registeredAtUtc, basisHash: hash(basis), resolution, mediaBindings: bindings }
      if (canonical(archive.payload) !== canonical(payload)) add(id, 'archive', 'payload_mismatch')
    }
    const kinds = mediaKinds.filter(kind => source[kind] !== null && source[kind] !== '')
    if (bindings && canonical(bindings.map(binding => binding.sourceKind)) !== canonical(kinds)) add(id, 'mediaBindings', 'kind_mismatch')
    for (const kind of kinds) {
      const media = mediaByKey.get(canonical([id, kind])), binding = bindings?.find(item => item.sourceKind === kind)
      if (!binding) add(id, `mediaBindings.${kind}`, 'missing')
      compare(id, 'media', { id: binding?.id ?? '', lesson_id: id, source_kind: kind, locator: source[kind], ...common }, media)
    }
    saved.delete(id)
  }
  for (const [table, rows] of Object.entries(tables)) for (const id of rows.keys()) add(id, table, 'unexpected')
  for (const id of saved.keys()) add(id, 'archive', 'unexpected')
  return { version: 'learning-course-import-audit/v1', sourceRows: sources.length,
    targetRows: Object.fromEntries(Object.entries(actual).map(([table, rows]) => [table, rows.length])), archiveRows: archives.length,
    differences, importMatchesReviewedInputs: differences.length === 0, checkedTargetFields: learningCourseAuditFields,
    evidenceCatalogExternallyRequired: true, mediaAvailabilityVerified: false, consumersSwitched: false, deletionAuthorized: false }
}
