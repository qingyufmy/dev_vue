import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { learningSecondsToMilliseconds } from './v4-learning-duration.mjs'
import { learningCoreFieldContract } from './v4-learning-field-contract.mjs'

export const learningMediaKinds = Object.freeze(['youtube_id', 'bilibili_id', 'cf_stream_id', 'local_video_path', 'article_url', 'article_object_key'])
const fields = learningCoreFieldContract().filter(field => field.sourceTable === 'courses').map(field => field.sourceField)
const strings = { title: 500, category: 50, content_type: 20, duration: 20, youtube_id: 50, cover: 500, gradient: 500,
  article_url: 500, article_object_key: 500, access_level: 20, cf_stream_id: 100, bilibili_id: 50, local_video_path: 500, status: 20 }
const counters = ['quiz_count', 'knowledge_count', 'mindmap_count', 'structure_count']
export function prepareLearningCourseRows(input, { run, basis, evidenceCatalog }) {
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'learning_course_run')
  const imported = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  check(Array.isArray(input) && evidenceCatalog instanceof Map, 'learning_course_inputs')
  const sources = structuredClone(input), ids = new Set(), episodes = new Set()
  for (const source of sources) {
    exactKeys(source, fields)
    for (const field of ['id', 'episode_id']) {
      represent(source[field], 'int', false)
      check(BigInt(source[field]) > 0n, 'learning_course_identity')
    }
    check(!ids.has(source.id) && !episodes.has(source.episode_id), 'learning_course_duplicate')
    ids.add(source.id); episodes.add(source.episode_id)
    for (const field of ['number', 'sort_order', ...counters]) represent(source[field], 'int', true)
    check([null, '0', '1'].includes(source.has_stream_video), 'learning_course_stream_flag')
    for (const [field, length] of Object.entries(strings)) represent(source[field], `varchar(${length})`, field !== 'title')
    check(source.description === null || (typeof source.description === 'string' && Buffer.byteLength(source.description) <= 65535
      && Buffer.from(source.description, 'utf8').toString('utf8') === source.description), 'learning_course_description')
    check([null, 'free', 'logged_in', 'plus_pro', 'pro_only'].includes(source.access_level)
      && [null, 'draft', 'published', 'archived'].includes(source.status)
      && [null, 'video', 'article'].includes(source.content_type), 'learning_course_enum')
    inspectWallClock(source.created_at); inspectWallClock(source.updated_at)
  }
  sources.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'resolutions'])
  check(basis.version === 'learning-course-import/v1' && basis.sourceHash === hash(sources) && basis.sourceSnapshotId === run.sourceSnapshotId
    && Array.isArray(basis.resolutions) && basis.resolutions.length === sources.length, 'learning_course_basis')
  const resolutions = new Map()
  for (const resolution of basis.resolutions) {
    exactKeys(resolution, ['sourceId', 'sourceHash', 'createdAt', 'updatedAt', 'valueEvidence'])
    check(!resolutions.has(resolution.sourceId), 'learning_course_resolution_duplicate')
    resolutions.set(resolution.sourceId, resolution)
  }
  const proof = item => check(typeof item.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.evidenceId)
    && typeof item.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.evidenceSha256)
    && evidenceCatalog.get(item.evidenceId) === item.evidenceSha256, 'learning_course_evidence')
  const time = (raw, rule) => {
    exactKeys(rule, ['raw', 'kind', 'offsetMinutes', 'evidenceId', 'evidenceSha256']); proof(rule)
    check(rule.raw === raw, 'learning_course_time_binding')
    if (raw === null) { check(rule.kind === 'source_null' && rule.offsetMinutes === null, 'learning_course_null_time'); return null }
    check(rule.kind === 'wall_clock' && Number.isInteger(rule.offsetMinutes) && Math.abs(rule.offsetMinutes) <= 840, 'learning_course_offset')
    const date = new Date(Date.parse(inspectWallClock(raw).canonicalWallClock.replace(' ', 'T') + 'Z') - rule.offsetMinutes * 60000)
    check(date.getUTCFullYear() >= 1000 && date.getUTCFullYear() <= 9999, 'learning_course_time_range')
    return date.toISOString().replace('T', ' ').slice(0, -1)
  }
  const entries = sources.map(source => {
    const sourceHash = hash(source), resolution = resolutions.get(source.id)
    check(resolution?.sourceHash === sourceHash, 'learning_course_source_binding')
    exactKeys(resolution.valueEvidence, ['evidenceId', 'evidenceSha256', 'requirements']); proof(resolution.valueEvidence)
    check(Array.isArray(resolution.valueEvidence.requirements) && JSON.stringify([...resolution.valueEvidence.requirements].sort())
      === JSON.stringify(['access_review', 'duration_seconds', 'media_reference_review', 'projection_archive_review']), 'learning_course_semantic_scope')
    const common = { created_at_utc: time(source.created_at, resolution.createdAt), updated_at_utc: time(source.updated_at, resolution.updatedAt),
      revision: '1', origin: 'legacy_import', migration_run_id: run.id, source_sha256: sourceHash, imported_at_utc: imported }
    const course = { id: source.id, title: source.title, description: source.description, category_key: source.category,
      cover_locator: source.cover, gradient_token: source.gradient, access_level: source.access_level, status: source.status, sort_order: source.sort_order, ...common }
    const lesson = { id: source.id, course_id: source.id, public_episode_id: source.episode_id, display_number: source.number,
      title: source.title, content_type: source.content_type, duration_ms: learningSecondsToMilliseconds(source.duration), sort_order: '0', ...common }
    // IDs are assigned by the database; the unique lesson/kind pair is the stable
    // migration reference. No external locator is normalized or dereferenced.
    const media = learningMediaKinds.filter(kind => source[kind] !== null && source[kind] !== '')
      .map(kind => ({ lesson_id: source.id, source_kind: kind, locator: source[kind], ...common }))
    const targets = { course, lesson, media }
    return { sourceId: source.id, sourceHash, targets, targetHash: hash(targets),
      provenance: { source, resolution: structuredClone(resolution), basisHash: hash(basis) } }
  })
  return { version: 'learning-course-rows/v1', sourceHash: hash(sources), transformHash: hash(entries), entries,
    lessonMappings: sources.map(source => ({ episodeId: source.episode_id, lessonId: source.id, lessonSourceHash: hash(source) }))
      .sort((a, b) => BigInt(a.episodeId) < BigInt(b.episodeId) ? -1 : 1),
    mediaAvailabilityVerified: false, consumersSwitched: false }
}
