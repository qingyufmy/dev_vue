import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { learningSecondsToMilliseconds } from './v4-learning-duration.mjs'

const sourceFields = ['id', 'user_id', 'episode_id', 'watched_seconds', 'total_duration', 'completed', 'quiz_passed', 'updated_at']
const id = value => check(typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && BigInt(value) <= 2147483647n, 'learning_progress_id')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function prepareLearningProgressRows(input, { run, basis, lessonMappings, userIds, evidenceCatalog }) {
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'learning_progress_run')
  const imported = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  check(Array.isArray(input) && Array.isArray(lessonMappings) && userIds instanceof Set && evidenceCatalog instanceof Map, 'learning_progress_inputs')
  const sources = structuredClone(input), mappings = structuredClone(lessonMappings)
  const seen = new Set(), scopes = new Set(), lessons = new Map(), lessonIds = new Set()
  for (const mapping of mappings) {
    exactKeys(mapping, ['episodeId', 'lessonId', 'lessonSourceHash'])
    id(mapping.episodeId); id(mapping.lessonId)
    check(digest(mapping.lessonSourceHash) && !lessons.has(mapping.episodeId) && !lessonIds.has(mapping.lessonId), 'learning_progress_mapping')
    lessons.set(mapping.episodeId, mapping); lessonIds.add(mapping.lessonId)
  }
  mappings.sort((a, b) => BigInt(a.episodeId) < BigInt(b.episodeId) ? -1 : 1)
  for (const source of sources) {
    exactKeys(source, sourceFields); id(source.id); id(source.user_id); id(source.episode_id)
    const scope = `${source.user_id}/${source.episode_id}`
    check(!seen.has(source.id) && !scopes.has(scope), 'learning_progress_duplicate')
    seen.add(source.id); scopes.add(scope)
    check(userIds.has(source.user_id) && lessons.has(source.episode_id), 'learning_progress_parent_missing')
    check([null, '0', '1'].includes(source.completed) && [null, '0', '1'].includes(source.quiz_passed), 'learning_progress_flags')
    inspectWallClock(source.updated_at)
  }
  sources.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'lessonMappingHash', 'resolutions'])
  check(basis.version === 'learning-progress-import/v1' && basis.sourceHash === hash(sources)
    && basis.sourceSnapshotId === run.sourceSnapshotId && basis.lessonMappingHash === hash(mappings)
    && Array.isArray(basis.resolutions) && basis.resolutions.length === sources.length, 'learning_progress_basis')
  const resolutions = new Map()
  for (const resolution of basis.resolutions) {
    exactKeys(resolution, ['sourceId', 'sourceHash', 'updatedAt'])
    check(!resolutions.has(resolution.sourceId), 'learning_progress_resolution_duplicate')
    resolutions.set(resolution.sourceId, resolution)
  }
  const entries = sources.map(source => {
    const sourceHash = hash(source), resolution = resolutions.get(source.id)
    check(resolution?.sourceHash === sourceHash, 'learning_progress_source_binding')
    const rule = resolution.updatedAt
    exactKeys(rule, ['raw', 'kind', 'offsetMinutes', 'evidenceId', 'evidenceSha256'])
    check(rule.raw === source.updated_at && typeof rule.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(rule.evidenceId)
      && digest(rule.evidenceSha256) && evidenceCatalog.get(rule.evidenceId) === rule.evidenceSha256, 'learning_progress_time_evidence')
    let updated = null
    if (source.updated_at === null) check(rule.kind === 'source_null' && rule.offsetMinutes === null, 'learning_progress_null_time')
    else {
      check(rule.kind === 'wall_clock' && Number.isInteger(rule.offsetMinutes) && Math.abs(rule.offsetMinutes) <= 840, 'learning_progress_offset')
      const wall = inspectWallClock(source.updated_at).canonicalWallClock
      const date = new Date(Date.parse(wall.replace(' ', 'T') + 'Z') - rule.offsetMinutes * 60000)
      check(date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999, 'learning_progress_time_range')
      updated = date.toISOString().replace('T', ' ').slice(0, -1)
    }
    const mapping = lessons.get(source.episode_id)
    const target = { id: source.id, user_id: source.user_id, lesson_id: mapping.lessonId,
      watched_ms: learningSecondsToMilliseconds(source.watched_seconds), reported_duration_ms: learningSecondsToMilliseconds(source.total_duration),
      completed: source.completed, quiz_passed: source.quiz_passed, updated_at_utc: updated, revision: '1', origin: 'legacy_import',
      migration_run_id: run.id, source_sha256: sourceHash, imported_at_utc: imported }
    return { sourceId: source.id, sourceHash, target, targetHash: hash(target),
      provenance: { source, lessonMapping: mapping, resolution: structuredClone(resolution), basisHash: hash(basis) } }
  })
  return { version: 'learning-progress-rows/v1', sourceHash: hash(sources), transformHash: hash(entries), entries, consumersSwitched: false }
}
