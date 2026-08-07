import { describe, expect, it, vi } from 'vitest'
import { getStorageOperationsSummary, runStorageMaintenance } from '../../server/storage/storage-operations.js'

describe('storage operations', () => {
  it('aggregates bounded metadata and reports local disk health without paths or secrets', async () => {
    const summary = await getStorageOperationsSummary({
      queryAllImpl:vi.fn().mockResolvedValue([
        { storage_provider:'local', purpose:'video', status:'ready', file_count:2, total_bytes:300 },
        { storage_provider:'qiniu', purpose:'image', status:'deleting', file_count:1, total_bytes:40 },
      ]),
      localRoot:'D:/private-media', mkdirImpl:vi.fn(), accessImpl:vi.fn(),
      statfsImpl:vi.fn().mockResolvedValue({ bsize:4096, blocks:1000, bavail:200 }),
    })
    expect(summary.totals).toMatchObject({ files:3, bytes:340, deleting:1, failed:0 })
    expect(summary.local).toMatchObject({ ok:true, writable:true, total_bytes:4096000, free_bytes:819200 })
    expect(JSON.stringify(summary)).not.toContain('private-media')
  })

  it('fails disk health closed while keeping database totals available', async () => {
    const summary = await getStorageOperationsSummary({ queryAllImpl:vi.fn().mockResolvedValue([]), localRoot:'x', mkdirImpl:vi.fn().mockRejectedValue(new Error('denied')) })
    expect(summary.totals.files).toBe(0)
    expect(summary.local).toMatchObject({ ok:false, writable:false, error:'storage_local_unavailable' })
  })

  it('claims expired sessions, deletes only unreferenced tracked objects, and leaves failures retryable', async () => {
    const queryAllImpl = vi.fn()
      .mockResolvedValueOnce([{ session_id:'s1', id:11, storage_provider:'qiniu', object_key:'website/dev/video/a' }])
      .mockResolvedValueOnce([
        { id:11, storage_provider:'qiniu', object_key:'website/dev/video/a' },
        { id:12, storage_provider:'local', object_key:'website/dev/image/b' },
      ])
    const run = vi.fn(async sql => {
      if (sql.includes('SELECT status')) return [[{ status:'pending' }]]
      return [{ affectedRows:1 }]
    })
    const queryOneImpl = vi.fn()
      .mockResolvedValueOnce({ course_resource_ref:0, post_asset_ref:0, video_stream_ref:0 })
      .mockResolvedValueOnce({ course_resource_ref:0, post_asset_ref:1, video_stream_ref:0 })
    const queryRunImpl = vi.fn().mockResolvedValue({ affectedRows:1 })
    const storage = { delete:vi.fn().mockResolvedValue({ deleted:true }) }
    const result = await runStorageMaintenance({ queryAllImpl, queryOneImpl, queryRunImpl, storage, withTransactionImpl:callback=>callback(run), batchSize:10 })
    expect(result).toEqual({ expired_sessions:1, deleted:1, failed:0, still_referenced:1, invalid:0 })
    expect(storage.delete).toHaveBeenCalledTimes(1)
    expect(storage.delete).toHaveBeenCalledWith({ provider:'qiniu', objectKey:'website/dev/video/a' })
  })

  it('keeps provider deletion failures in deleting state for the next bounded retry', async () => {
    const queryAllImpl = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id:20, storage_provider:'qiniu', object_key:'website/dev/video/fail' }])
    const queryOneImpl = vi.fn().mockResolvedValue({ course_resource_ref:0, post_asset_ref:0, video_stream_ref:0 })
    const queryRunImpl = vi.fn().mockResolvedValue({ affectedRows:1 })
    const storage = { delete:vi.fn().mockRejectedValue(new Error('remote unavailable')) }
    const result = await runStorageMaintenance({ queryAllImpl, queryOneImpl, queryRunImpl, storage, withTransactionImpl:vi.fn(), batchSize:10 })
    expect(result.failed).toBe(1)
    expect(queryRunImpl.mock.calls.some(call => call[0].includes("status = 'deleting'"))).toBe(true)
  })
})
