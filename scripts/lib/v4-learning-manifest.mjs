import { open, readFile } from 'node:fs/promises'
import { canonical, exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { createLearningCourseBackfill } from './v4-learning-course-backfill.mjs'
import { createLearningProgressBackfill } from './v4-learning-progress-backfill.mjs'
import { validateSpec as validateCourses } from './v4-learning-course-backfill-contract.mjs'
import { validateSpec as validateProgress } from './v4-learning-progress-backfill-contract.mjs'

const catalog = evidence => {
  check(evidence instanceof Map && evidence.size > 0 && evidence.size <= 1000, 'learning_manifest_evidence')
  for (const [id, digest] of evidence) check(typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)
    && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'learning_manifest_evidence')
  return [...evidence].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
}
const recipe = (kind, sources, options, batchSize) => {
  check(['courses', 'progress'].includes(kind), 'learning_manifest_kind')
  return (kind === 'courses' ? createLearningCourseBackfill : createLearningProgressBackfill)(sources, options, { batchSize })
}
export function learningManifestHash(manifest) {
  const copy = structuredClone(manifest)
  check(copy?.spec?.bindings, 'learning_manifest_shape')
  copy.spec.bindings.manifestHash = '0'.repeat(64)
  return hash(copy)
}
export function buildLearningManifest({ kind, sources, options, targetIdentity, logicalSourceId, mirrorDatabase, admission, batchSize = 100 }) {
  exactKeys(targetIdentity, ['serverUuid', 'database', 'storageMode', 'schemaHash'])
  exactKeys(options, ['run', 'basis', 'evidenceCatalog', ...(kind === 'progress' ? ['lessonMappings', 'userIds'] : [])])
  const evidence = catalog(options.evidenceCatalog), prepared = recipe(kind, sources, options, batchSize)
  check(targetIdentity.storageMode === prepared.writer.storageMode, 'learning_manifest_target_mode')
  const manifest = { version: 'learning-manifest/v1', kind,
    sourceIds: prepared.batches.flatMap(batch => batch.rows.map(row => row.payload.entry.sourceId)),
    options: { run: structuredClone(options.run), basis: structuredClone(options.basis), evidenceCatalog: evidence,
      ...(kind === 'progress' ? { lessonMappings: structuredClone(options.lessonMappings) } : {}) },
    spec: { runId: prepared.runId, admission: structuredClone(admission), bindings: {
      logicalSourceId, sourceDatabase: targetIdentity.database, mirrorDatabase, targetServerUuid: targetIdentity.serverUuid,
      targetDatabase: targetIdentity.database, schemaHash: targetIdentity.schemaHash, storageMode: targetIdentity.storageMode,
      snapshotHash: prepared.sourceHash, transformHash: prepared.transformHash, manifestHash: '0'.repeat(64), streams: [prepared.stream],
    } }, batchSize }
  manifest.spec.bindings.manifestHash = learningManifestHash(manifest)
  decodeLearningManifest(manifest, { sources, evidenceCatalog: options.evidenceCatalog, userIds: options.userIds })
  return manifest
}

// Source rows and current users are read externally, never trusted from a saved
// manifest. Evidence hashes must agree with the separately supplied review catalog.
export function decodeLearningManifest(input, { sources, evidenceCatalog, userIds }) {
  const manifest = structuredClone(input)
  exactKeys(manifest, ['version', 'kind', 'sourceIds', 'options', 'spec', 'batchSize'])
  check(manifest.version === 'learning-manifest/v1' && ['courses', 'progress'].includes(manifest.kind), 'learning_manifest_version')
  exactKeys(manifest.options, ['run', 'basis', 'evidenceCatalog', ...(manifest.kind === 'progress' ? ['lessonMappings'] : [])])
  check(manifest.spec?.bindings?.manifestHash === learningManifestHash(manifest), 'learning_manifest_hash')
  const validate = manifest.kind === 'courses' ? validateCourses : validateProgress
  validate(manifest.spec)
  check(Array.isArray(manifest.options.evidenceCatalog), 'learning_manifest_evidence')
  const trusted = new Map(catalog(evidenceCatalog)), included = new Map(manifest.options.evidenceCatalog)
  check(canonical(catalog(included)) === canonical(manifest.options.evidenceCatalog), 'learning_manifest_evidence')
  for (const [id, digest] of included) check(trusted.get(id) === digest, 'learning_manifest_evidence_untrusted')
  const options = { run: manifest.options.run, basis: manifest.options.basis, evidenceCatalog: included,
    ...(manifest.kind === 'progress' ? { lessonMappings: manifest.options.lessonMappings, userIds: new Set(userIds ?? []) } : {}) }
  check(manifest.kind !== 'progress' || userIds instanceof Set, 'learning_manifest_users_required')
  const prepared = recipe(manifest.kind, sources, options, manifest.batchSize)
  check(canonical(manifest.sourceIds) === canonical(prepared.batches.flatMap(batch => batch.rows.map(row => row.payload.entry.sourceId))), 'learning_manifest_source_ids')
  check(manifest.spec.runId === prepared.runId && manifest.spec.bindings.snapshotHash === prepared.sourceHash
    && manifest.spec.bindings.transformHash === prepared.transformHash, 'learning_manifest_binding')
  return { kind: manifest.kind, spec: manifest.spec, sources: structuredClone(sources), options, batchSize: manifest.batchSize }
}

export async function persistLearningManifest(path, manifest) {
  check(manifest.spec?.bindings?.manifestHash === learningManifestHash(manifest), 'learning_manifest_hash')
  let file
  try { file = await open(path, 'wx', 0o600) }
  catch (error) { if (error.code !== 'EEXIST') throw Error('learning_manifest_create_failed') }
  if (file) {
    try { await file.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await file.sync() }
    catch { throw Error('learning_manifest_write_unknown') }
    finally { await file.close() }
  }
  let saved
  try { saved = JSON.parse(await readFile(path, 'utf8')) }
  catch { throw Error('learning_manifest_file_invalid') }
  check(canonical(saved) === canonical(manifest), 'learning_manifest_file_conflict')
  return saved
}
