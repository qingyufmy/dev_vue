import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildLearningManifest, decodeLearningManifest, learningManifestHash, persistLearningManifest } from '../scripts/lib/v4-learning-manifest.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'

function fixture(kind = 'courses') {
  const f = kind === 'courses' ? learningCourseFixture() : learningProgressFixture()
  const input = { kind, sources: [f.source], options: f.options, logicalSourceId: 'fixture', mirrorDatabase: 'mirror', admission: { approved: true, blockers: [] },
    targetIdentity: { database: 'dev_vue', serverUuid: f.options.run.id, storageMode: `inplace-learning-${kind === 'courses' ? 'course' : 'progress'}-v1`, schemaHash: 'c'.repeat(64) } }
  return { ...f, input, decode: manifest => decodeLearningManifest(manifest, { sources: [f.source], evidenceCatalog: f.options.evidenceCatalog, userIds: f.options.userIds }) }
}
it.each(['courses', 'progress'])('round trips %s without embedding business source rows or substituting time evidence', kind => {
  const f = fixture(kind), manifest = buildLearningManifest(f.input), loaded = f.decode(JSON.parse(JSON.stringify(manifest)))
  expect(loaded.sources).toEqual([f.source])
  expect(loaded.options.basis).toEqual(f.options.basis)
  expect(manifest.spec.bindings.manifestHash).toBe(learningManifestHash(manifest))
  expect(manifest.sources).toBeUndefined()
  expect(manifest.sourceIds).toEqual([f.source.id])
})
it('rejects edited manifests, changed actual source and external review mismatches', () => {
  const f = fixture(), manifest = buildLearningManifest(f.input)
  manifest.batchSize = 1
  expect(() => f.decode(manifest)).toThrow('learning_manifest_hash')
  const g = fixture(), good = buildLearningManifest(g.input)
  g.source.title = 'changed'
  expect(() => g.decode(good)).toThrow('learning_course_basis')
  const h = fixture(), trusted = buildLearningManifest(h.input)
  h.options.evidenceCatalog.set('fixture', 'b'.repeat(64))
  expect(() => h.decode(trusted)).toThrow('learning_manifest_evidence_untrusted')
})
it('still validates source IDs and bindings after a caller recalculates the manifest hash', () => {
  const f = fixture(), manifest = buildLearningManifest(f.input)
  manifest.sourceIds = ['999']
  manifest.spec.bindings.manifestHash = learningManifestHash(manifest)
  expect(() => f.decode(manifest)).toThrow('learning_manifest_source_ids')
  manifest.sourceIds = ['12']; manifest.spec.bindings.transformHash = 'e'.repeat(64)
  manifest.spec.bindings.manifestHash = learningManifestHash(manifest)
  expect(() => f.decode(manifest)).toThrow('learning_manifest_binding')
})
it('requires current user existence for progress and explicit wave admission', () => {
  const f = fixture('progress'), manifest = buildLearningManifest(f.input)
  f.options.userIds.clear()
  expect(() => f.decode(manifest)).toThrow('learning_progress_parent_missing')
  const g = fixture(); g.input.admission.blockers.push('time_unresolved')
  expect(() => buildLearningManifest(g.input)).toThrow('backfill_wave_not_approved')
})
it('persists exclusively, permits identical replay and never overwrites conflicts or partial files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'learning-manifest-'))
  try {
    const path = join(directory, 'manifest.json'), f = fixture(), manifest = buildLearningManifest(f.input)
    await persistLearningManifest(path, manifest)
    expect(await persistLearningManifest(path, manifest)).toEqual(manifest)
    const before = await readFile(path, 'utf8')
    const changed = structuredClone(manifest); changed.batchSize = 1; changed.spec.bindings.manifestHash = learningManifestHash(changed)
    await expect(persistLearningManifest(path, changed)).rejects.toThrow('learning_manifest_file_conflict')
    expect(await readFile(path, 'utf8')).toBe(before)
    const partial = join(directory, 'partial.json'); await writeFile(partial, '{')
    await expect(persistLearningManifest(partial, manifest)).rejects.toThrow('learning_manifest_file_invalid')
    expect(await readFile(partial, 'utf8')).toBe('{')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
