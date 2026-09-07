import { hash } from '../../scripts/lib/v4-backfill-contract.mjs'
export function learningProgressFixture() {
  const source = { id: '2', user_id: '1', episode_id: '100', watched_seconds: '2049', total_duration: '599', completed: '1', quiz_passed: '0', updated_at: '2026-01-01 01:00:00' }
  const lessonMappings = [{ episodeId: '100', lessonId: '12', lessonSourceHash: 'b'.repeat(64) }]
  const proof = { evidenceId: 'fixture', evidenceSha256: 'a'.repeat(64) }
  const options = { run: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'fixture', registeredAtUtc: '2026-09-07T00:00:00.000Z' },
    lessonMappings, userIds: new Set(['1']), evidenceCatalog: new Map([[proof.evidenceId, proof.evidenceSha256]]),
    basis: { version: 'learning-progress-import/v1', sourceHash: hash([source]), sourceSnapshotId: 'fixture', lessonMappingHash: hash(lessonMappings),
      resolutions: [{ sourceId: source.id, sourceHash: hash(source), updatedAt: { raw: source.updated_at, kind: 'wall_clock', offsetMinutes: 480, ...proof } }] } }
  return { source, options }
}
