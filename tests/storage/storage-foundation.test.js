import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { queryAll } = vi.hoisted(() => ({ queryAll: vi.fn() }))
vi.mock('../../server/db.js', () => ({ queryAll, queryRun:vi.fn() }))

import { LocalStorageProvider } from '../../server/storage/local-storage-provider.js'
import { getStorageConfigSummary, getStorageLocalRoot, invalidateStorageConfigCache, loadStorageConfig, readStorageConfigFromRows, resolveConfiguredProvider } from '../../server/storage/storage-config.js'
import { createHealthcheckObjectKey, createStorageObjectKey, validateObjectKey, validateStorageUpload } from '../../server/storage/storage-policy.js'

describe('unified storage foundation', () => {
  beforeEach(() => {
    queryAll.mockReset()
    invalidateStorageConfigCache()
  })

  it('resolves inherit without exposing credentials and invalidates cached config', async () => {
    queryAll.mockResolvedValueOnce([
      { category:'media_storage', key:'default_provider', value:'qiniu' },
      { category:'media_storage', key:'video_provider', value:'inherit' },
      { category:'media_storage', key:'qiniu_connection_test_status', value:'succeeded' },
      { category:'media_storage', key:'qiniu_connection_test_version', value:'stale-version' },
      { category:'media_storage', key:'qiniu_connection_tested_at', value:'2099-01-01 00:00:00' },
      { category:'qiniu', key:'access_key', value:'access' },
      { category:'qiniu', key:'secret_key', value:'secret' },
      { category:'qiniu', key:'bucket', value:'bucket' },
      { category:'qiniu', key:'domain', value:'https://cdn.example.test' },
    ])
    const config = await loadStorageConfig({ force:true })
    expect(resolveConfiguredProvider('video', config.media)).toBe('qiniu')
    expect(config.qiniuTest.valid).toBe(false)
    const summary = getStorageConfigSummary(config)
    expect(summary.effective_provider.video).toBe('qiniu')
    expect(summary.qiniu).not.toHaveProperty('access_key')
    expect(summary.qiniu.test.config_version).toBe('stale-version')
    queryAll.mockResolvedValueOnce([])
    invalidateStorageConfigCache()
    const next = await loadStorageConfig({ force:true })
    expect(next.media.default_provider).toBe('local')
    expect(queryAll).toHaveBeenCalledTimes(2)
  })

  it('uses a deterministic environment/purpose object key and rejects traversal', () => {
    expect(createStorageObjectKey({ purpose:'attachment', environment:'prod', id:'abc12345' })).toBe('website/prod/attachment/abc12345')
    expect(() => createStorageObjectKey({ purpose:'attachment', environment:'prod', id:'../escape' })).toThrow('storage_object_key_invalid')
  })

  it('uses a validated text extension for healthcheck object keys', () => {
    const key = createHealthcheckObjectKey({ environment:'prod', id:'abc12345' })
    expect(key).toBe('website/prod/healthcheck/abc12345.txt')
    expect(validateObjectKey(key)).toBe(key)
  })

  it('defaults local storage below the private server directory, never public uploads', () => {
    const previous = process.env.MEDIA_STORAGE_LOCAL_ROOT
    try {
      delete process.env.MEDIA_STORAGE_LOCAL_ROOT
      const root = getStorageLocalRoot()
      expect(root).toContain(`${path.sep}server${path.sep}private-uploads${path.sep}media-storage`)
      expect(root).not.toContain(`${path.sep}public${path.sep}uploads`)
    } finally {
      if (previous === undefined) delete process.env.MEDIA_STORAGE_LOCAL_ROOT
      else process.env.MEDIA_STORAGE_LOCAL_ROOT = previous
    }
  })

  it('requires MIME and extension when a purpose has an allowlist and rejects obvious future tests', () => {
    expect(() => validateStorageUpload({ purpose:'video', sizeBytes:10 })).toThrow('storage_mime_type_invalid')
    expect(() => validateStorageUpload({ purpose:'video', sizeBytes:10, mimeType:'video/mp4' })).toThrow('storage_extension_invalid')
    expect(() => validateStorageUpload({ purpose:'image', sizeBytes:10, mimeType:'image/png', originalName:'cover.gif' })).toThrow('storage_extension_invalid')
    const base = readStorageConfigFromRows([
      { category:'qiniu', key:'access_key', value:'access' },
      { category:'qiniu', key:'secret_key', value:'secret' },
      { category:'qiniu', key:'bucket', value:'bucket' },
      { category:'qiniu', key:'domain', value:'https://cdn.example.test' },
    ])
    const future = readStorageConfigFromRows([
      { category:'media_storage', key:'qiniu_connection_test_status', value:'succeeded' },
      { category:'media_storage', key:'qiniu_connection_test_version', value:base.configVersion },
      { category:'media_storage', key:'qiniu_connection_tested_at', value:'2999-01-01 00:00:00' },
      { category:'qiniu', key:'access_key', value:'access' },
      { category:'qiniu', key:'secret_key', value:'secret' },
      { category:'qiniu', key:'bucket', value:'bucket' },
      { category:'qiniu', key:'domain', value:'https://cdn.example.test' },
    ])
    expect(future.qiniuTest.valid).toBe(false)
    expect(future.qiniuTest.status).toBe('stale')
  })

  it('marks expired or pending-cleanup successes as stale rather than valid', () => {
    const base = readStorageConfigFromRows([
      { category:'media_storage', key:'qiniu_connection_test_status', value:'not_tested' },
      { category:'qiniu', key:'access_key', value:'access' },
      { category:'qiniu', key:'secret_key', value:'secret' },
      { category:'qiniu', key:'bucket', value:'bucket' },
      { category:'qiniu', key:'domain', value:'https://cdn.example.test' },
    ])
    const stale = readStorageConfigFromRows([
      { category:'media_storage', key:'qiniu_connection_test_status', value:'succeeded' },
      { category:'media_storage', key:'qiniu_connection_test_version', value:base.configVersion },
      { category:'media_storage', key:'qiniu_connection_tested_at', value:'2000-01-01 00:00:00' },
      { category:'qiniu', key:'access_key', value:'access' },
      { category:'qiniu', key:'secret_key', value:'secret' },
      { category:'qiniu', key:'bucket', value:'bucket' },
      { category:'qiniu', key:'domain', value:'https://cdn.example.test' },
    ])
    expect(stale.qiniuTest.valid).toBe(false)
    expect(stale.qiniuTest.status).toBe('stale')
    const pending = readStorageConfigFromRows([
      { category:'media_storage', key:'qiniu_connection_test_status', value:'succeeded' },
      { category:'media_storage', key:'qiniu_connection_test_version', value:base.configVersion },
      { category:'media_storage', key:'qiniu_connection_tested_at', value:'2099-01-01 00:00:00' },
      { category:'media_storage', key:'qiniu_connection_test_cleanup_pending', value:'true' },
      { category:'qiniu', key:'access_key', value:'access' },
      { category:'qiniu', key:'secret_key', value:'secret' },
      { category:'qiniu', key:'bucket', value:'bucket' },
      { category:'qiniu', key:'domain', value:'https://cdn.example.test' },
    ])
    expect(pending.qiniuTest.valid).toBe(false)
    expect(pending.qiniuTest.status).toBe('stale')
  })

  it('writes local objects atomically and makes deletion idempotent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aurum-storage-'))
    try {
      const provider = new LocalStorageProvider({ root })
      const first = await provider.put({ objectKey:'website/dev/resource/file-a', body:Buffer.from('hello'), mimeType:'text/plain' })
      expect(first.sizeBytes).toBe(5)
      expect(await readFile(path.join(root, 'website/dev/resource/file-a'), 'utf8')).toBe('hello')
      await expect(provider.put({ objectKey:'website/dev/resource/file-a', body:Buffer.from('again') })).rejects.toThrow('storage_object_exists')
      const races = await Promise.allSettled([
        provider.put({ objectKey:'website/dev/resource/file-race', body:Buffer.from('one') }),
        provider.put({ objectKey:'website/dev/resource/file-race', body:Buffer.from('two') }),
      ])
      expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(races.filter(result => result.status === 'rejected' && result.reason?.message === 'storage_object_exists')).toHaveLength(1)
      expect((await provider.delete({ objectKey:'website/dev/resource/file-a' })).existed).toBe(true)
      expect((await provider.delete({ objectKey:'website/dev/resource/file-a' })).existed).toBe(false)
      await expect(provider.stat({ objectKey:'../outside' })).rejects.toThrow('storage_object_key_invalid')
    } finally {
      await rm(root, { recursive:true, force:true })
    }
  })
})
