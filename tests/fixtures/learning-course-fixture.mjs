import { hash } from '../../scripts/lib/v4-backfill-contract.mjs'
import { learningCoreFieldContract } from '../../scripts/lib/v4-learning-field-contract.mjs'
export function learningCourseFixture() {
  const source = Object.fromEntries(learningCoreFieldContract().filter(field => field.sourceTable === 'courses').map(field => [field.sourceField, null]))
  Object.assign(source, { id: '12', episode_id: '100', number: '3', title: 'fixture-title', description: 'fixture-description', category: 'indicator', content_type: 'video',
    duration: '599', access_level: 'logged_in', status: 'published', has_stream_video: '1', quiz_count: '9', bilibili_id: 'fixture-bv', youtube_id: '',
    article_url: 'https://example.invalid/original?a=1', created_at: '2026-01-01 01:00:00', updated_at: null })
  const proof = { evidenceId: 'fixture', evidenceSha256: 'a'.repeat(64) }
  const options = { run: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'fixture', registeredAtUtc: '2026-09-07T00:00:00.000Z' },
    evidenceCatalog: new Map([[proof.evidenceId, proof.evidenceSha256]]), basis: { version: 'learning-course-import/v1', sourceHash: hash([source]), sourceSnapshotId: 'fixture',
      resolutions: [{ sourceId: source.id, sourceHash: hash(source), createdAt: { raw: source.created_at, kind: 'wall_clock', offsetMinutes: 480, ...proof },
        updatedAt: { raw: null, kind: 'source_null', offsetMinutes: null, ...proof },
        valueEvidence: { ...proof, requirements: ['access_review', 'duration_seconds', 'media_reference_review', 'projection_archive_review'] } }] } }
  return { source, options }
}
