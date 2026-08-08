import { describe, expect, it, vi, beforeEach } from 'vitest'

const { queryOne, queryRun, withTransaction } = vi.hoisted(() => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
}))
vi.mock('../../server/db.js', () => ({ queryOne, queryRun, withTransaction }))

import { confirmDirectStorageSession, createMultipartStoredFile } from '../../server/storage/stored-file-service.js'
import { StorageService } from '../../server/storage/storage-service.js'

describe('stored file lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withTransaction.mockImplementation(async callback => callback(async () => [{ insertId: 101, affectedRows: 1 }, []]))
  })

  it('writes local bytes and business link in one DB transaction without fallback', async () => {
    const deleted = vi.fn()
    const storage = {
      config:{ configVersion:'qiniu-fingerprint' },
      configuredProvider:vi.fn(() => 'local'),
      put:vi.fn(async () => ({ provider:'local', objectKey:'website/dev/image/local1', sizeBytes:4 })),
      delete:deleted,
    }
    const result = await createMultipartStoredFile({
      storage, purpose:'image', body:Buffer.from([0x89, 0x50, 0x4e, 0x47]), originalName:'cover.png', mimeType:'image/png',
      ownerType:'post_image', ownerId:7, createdBy:7,
      insertBusiness:vi.fn(async () => ({ id:3 })),
    })
    expect(result.provider).toBe('local')
    expect(storage.put).toHaveBeenCalledOnce()
    expect(deleted).not.toHaveBeenCalled()
    expect(withTransaction).toHaveBeenCalledOnce()
  })

  it('never deletes an object when a duplicate confirm loses the conditional update race', async () => {
    const session = {
      id:'session-1', stored_file_id:9, provider:'qiniu', purpose:'image', object_key:'website/dev/image/object1',
      original_name:'cover.png', mime_type:'image/png', size_bytes:4, owner_type:'post_image', owner_id:7,
      created_by:7, status:'pending', expires_at:'2999-01-01 00:00:00', config_version:'qiniu-fingerprint',
    }
    queryOne.mockResolvedValueOnce(session).mockResolvedValueOnce({ status:'confirmed', stored_file_status:'ready' })
    const deleted = vi.fn()
    const storage = {
      config:{ configVersion:'qiniu-fingerprint' },
      confirmDirectUpload:vi.fn(async () => ({ sizeBytes:4, mimeType:'image/png' })),
      delete:deleted,
    }
    withTransaction.mockImplementationOnce(async callback => callback(async () => [{ affectedRows:0 }, []]))
    await expect(confirmDirectStorageSession({
      storage, sessionId:'session-1', createdBy:7, result:{ key:session.object_key },
      insertBusiness:vi.fn(),
    })).rejects.toMatchObject({ code:'storage_session_already_confirmed' })
    expect(deleted).not.toHaveBeenCalled()
    expect(queryRun).not.toHaveBeenCalledWith(expect.stringContaining("status = 'deleting'"), expect.anything())
  })

  it('does not clean up a winner when the losing business transaction fails', async () => {
    const session = {
      id:'session-2', stored_file_id:10, provider:'qiniu', purpose:'attachment', object_key:'website/dev/attachment/object2',
      original_name:'notes.pdf', mime_type:'application/pdf', size_bytes:4, owner_type:'course_attachment', owner_id:7,
      created_by:7, status:'pending', expires_at:'2999-01-01 00:00:00', config_version:'qiniu-fingerprint',
    }
    queryOne.mockResolvedValueOnce(session).mockResolvedValueOnce({ status:'confirmed', stored_file_status:'ready' })
    const deleted = vi.fn()
    const storage = {
      config:{ configVersion:'qiniu-fingerprint' },
      confirmDirectUpload:vi.fn(async () => ({ sizeBytes:4, mimeType:'application/pdf' })),
      delete:deleted,
    }
    withTransaction.mockImplementationOnce(async () => { throw new Error('business_link_failed') })
    await expect(confirmDirectStorageSession({
      storage, sessionId:session.id, createdBy:7, result:{ key:session.object_key },
      insertBusiness:vi.fn(),
    })).rejects.toMatchObject({ code:'storage_session_already_confirmed' })
    expect(deleted).not.toHaveBeenCalled()
  })

  it('allows existing qiniu objects to be read after the connection proof expires', async () => {
    const fakeProvider = { createReadUrl:vi.fn(async () => 'https://cdn.example.test/signed'), delete:vi.fn() }
    const service = new StorageService({
      config:{ configVersion:'qiniu-fingerprint', media:{ default_provider:'local', image_provider:'inherit' }, qiniu:{ access_key:'ak', secret_key:'sk', bucket:'b', domain:'https://cdn.example.test', private_bucket:'true' }, qiniuTest:{ valid:false, configVersion:'stale' } },
      qiniuProvider:fakeProvider,
      localProvider:{},
    })
    expect(await service.createReadUrl({ provider:'qiniu', objectKey:'website/dev/image/existing1' })).toContain('https://cdn.example.test')
    expect(fakeProvider.createReadUrl).toHaveBeenCalledOnce()
    await expect(service.createReadUrl({ provider:'qiniu', objectKey:'website/dev/image/existing2', config_version:'changed-fingerprint' })).resolves.toContain('https://cdn.example.test')
  })
})
