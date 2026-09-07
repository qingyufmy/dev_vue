import { canonical, exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const learningProgressAuditFields = Object.freeze(['id', 'user_id', 'lesson_id', 'watched_ms', 'reported_duration_ms', 'completed', 'quiz_passed',
  'updated_at_utc', 'revision', 'origin', 'migration_run_id', 'source_sha256', 'imported_at_utc'])
const sourceFields = ['id', 'user_id', 'episode_id', 'watched_seconds', 'total_duration', 'completed', 'quiz_passed', 'updated_at']
const positiveId = value => check(typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && BigInt(value) <= 2147483647n, 'learning_progress_audit_id')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const unique = (rows, key) => {
  const result = new Map()
  for (const row of rows) {
    check(typeof row[key] === 'string' && !result.has(row[key]), 'learning_progress_audit_duplicate')
    result.set(row[key], row)
  }
  return result
}
// Independent arithmetic and expected fields: do not import the row converter or
// writer. Inputs must be SQL text, and actual rows/archives must be read afresh.
const milliseconds = value => {
  if (value === null) return null
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value), 'learning_progress_audit_seconds')
  const [whole, fraction = ''] = value.split('.')
  check(!/[1-9]/.test(fraction.slice(3)), 'learning_progress_audit_precision')
  const result = BigInt(whole) * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, '0'))
  check(result <= 9223372036854775807n, 'learning_progress_audit_range')
  return String(result)
}

export function auditLearningProgressImport(sources, actual, archives, { run, basis, lessonMappings, actualLessons, userIds, evidenceCatalog }) {
  check([sources, actual, archives, lessonMappings, actualLessons].every(Array.isArray)
    && userIds instanceof Set && evidenceCatalog instanceof Map, 'learning_progress_audit_input')
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'learning_progress_audit_run')
  const registered = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  for (const source of sources) { exactKeys(source, sourceFields); positiveId(source.id); positiveId(source.user_id); positiveId(source.episode_id) }
  unique(sources, 'id')
  const scopes = new Set()
  const sorted = [...sources].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
  const mappings = [...lessonMappings].sort((a, b) => BigInt(a.episodeId) < BigInt(b.episodeId) ? -1 : 1)
  for (const mapping of mappings) {
    exactKeys(mapping, ['episodeId', 'lessonId', 'lessonSourceHash'])
    positiveId(mapping.episodeId); positiveId(mapping.lessonId)
    check(digest(mapping.lessonSourceHash), 'learning_progress_audit_mapping')
  }
  const byEpisode = unique(mappings, 'episodeId')
  unique(mappings, 'lessonId')
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'lessonMappingHash', 'resolutions'])
  check(basis.version === 'learning-progress-import/v1' && basis.sourceHash === hash(sorted)
    && basis.sourceSnapshotId === run.sourceSnapshotId && basis.lessonMappingHash === hash(mappings)
    && Array.isArray(basis.resolutions) && basis.resolutions.length === sorted.length, 'learning_progress_audit_basis')
  const resolutions = unique(basis.resolutions, 'sourceId'), targets = unique(actual, 'id'), saved = unique(archives, 'sourceId')
  const lessons = unique(actualLessons, 'id'), differences = []
  const add = (sourceId, field, code) => differences.push({ sourceId, field, code })
  for (const source of sorted) {
    const id = source.id, sourceHash = hash(source), mapping = byEpisode.get(source.episode_id), resolution = resolutions.get(id)
    const scope = `${source.user_id}/${source.episode_id}`
    check(!scopes.has(scope), 'learning_progress_audit_duplicate_scope'); scopes.add(scope)
    check(mapping && resolution?.sourceHash === sourceHash, 'learning_progress_audit_binding')
    exactKeys(resolution, ['sourceId', 'sourceHash', 'updatedAt'])
    const rule = resolution.updatedAt
    exactKeys(rule, ['raw', 'kind', 'offsetMinutes', 'evidenceId', 'evidenceSha256'])
    check(rule.raw === source.updated_at && typeof rule.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(rule.evidenceId)
      && digest(rule.evidenceSha256) && evidenceCatalog.get(rule.evidenceId) === rule.evidenceSha256, 'learning_progress_audit_evidence')
    let updated = null
    if (source.updated_at === null) check(rule.kind === 'source_null' && rule.offsetMinutes === null, 'learning_progress_audit_null_time')
    else {
      check(rule.kind === 'wall_clock' && Number.isInteger(rule.offsetMinutes) && Math.abs(rule.offsetMinutes) <= 840, 'learning_progress_audit_offset')
      const date = new Date(Date.parse(inspectWallClock(source.updated_at).canonicalWallClock.replace(' ', 'T') + 'Z') - rule.offsetMinutes * 60000)
      check(date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999, 'learning_progress_audit_time_range')
      updated = date.toISOString().replace('T', ' ').slice(0, -1)
    }
    check([null, '0', '1'].includes(source.completed) && [null, '0', '1'].includes(source.quiz_passed), 'learning_progress_audit_flags')
    if (!userIds.has(source.user_id)) add(id, 'user', 'missing')
    const lesson = lessons.get(mapping.lessonId)
    if (!lesson) add(id, 'lesson', 'missing')
    else if (lesson.public_episode_id !== mapping.episodeId || lesson.source_sha256 !== mapping.lessonSourceHash) add(id, 'lesson', 'identity_mismatch')
    const expected = { id, user_id: source.user_id, lesson_id: mapping.lessonId, watched_ms: milliseconds(source.watched_seconds),
      reported_duration_ms: milliseconds(source.total_duration), completed: source.completed, quiz_passed: source.quiz_passed,
      updated_at_utc: updated, revision: '1', origin: 'legacy_import', migration_run_id: run.id, source_sha256: sourceHash, imported_at_utc: registered }
    const target = targets.get(id)
    if (!target) add(id, 'target', 'missing')
    else {
      exactKeys(target, learningProgressAuditFields)
      for (const field of learningProgressAuditFields) {
        const value = field.endsWith('_at_utc') ? inspectWallClock(target[field]).canonicalWallClock : target[field]
        if (value !== expected[field]) add(id, field, 'value_mismatch')
      }
    }
    const archive = saved.get(id)
    if (!archive) add(id, 'archive', 'missing')
    else {
      if (archive.runId !== run.id || archive.sourceHash !== sourceHash || archive.sourcePkHash !== hash([{ type: 'integer', value: id }])) add(id, 'archive', 'identity_mismatch')
      const payload = { version: 1, sourceTable: 'progress', projection: 'learning-progress-source/v1', source,
        sourceSnapshotId: run.sourceSnapshotId, registeredAtUtc: run.registeredAtUtc, basisHash: hash(basis), lessonMapping: mapping, resolution }
      if (canonical(archive.payload) !== canonical(payload)) add(id, 'archive', 'payload_mismatch')
    }
    targets.delete(id); saved.delete(id)
  }
  for (const id of targets.keys()) add(id, 'target', 'unexpected')
  for (const id of saved.keys()) add(id, 'archive', 'unexpected')
  return { version: 'learning-progress-import-audit/v1', sourceRows: sources.length, targetRows: actual.length, archiveRows: archives.length, differences,
    importMatchesReviewedInputs: differences.length === 0, checkedTargetFields: learningProgressAuditFields,
    evidenceCatalogExternallyRequired: true, consumersSwitched: false, deletionAuthorized: false }
}
