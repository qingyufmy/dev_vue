import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source=readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')

describe('media storage append-only migration', () => {
  it('adds a new migration with BIGINT facts and config test version fields', () => {
    expect(source).toContain("id: '174_unified_media_storage_foundation'")
    expect(source).toContain('CREATE TABLE IF NOT EXISTS stored_files')
    expect(source).toContain('size_bytes BIGINT UNSIGNED')
    expect(source).toContain('uk_stored_files_provider_object')
    expect(source).toContain('qiniu_connection_test_version')
    expect(source).toContain('qiniu_connection_test_cleanup_pending')
    expect(source).toContain('stored_file_id BIGINT UNSIGNED DEFAULT NULL')
    expect(source).toContain("id: '176_unified_video_storage_links'")
    expect(source).toContain("ADD COLUMN video_source VARCHAR(24) DEFAULT NULL")
    expect(source).toContain('idx_video_streams_source_episode')
  })
})
