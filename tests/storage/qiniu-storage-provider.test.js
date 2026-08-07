import { describe, expect, it } from 'vitest'
import { QiniuStorageProvider } from '../../server/storage/qiniu-storage-provider.js'

const HEALTH_BODY=Buffer.from('aurum-storage-healthcheck', 'utf8')

function fakeSdk({ deleteStatus = 200, mimeType = 'text/plain', downloadUrl } = {}) {
  const objects=new Map()
  const calls={ uploads:[], deletes:[] }
  class Mac { constructor(accessKey, secretKey) { this.accessKey=accessKey; this.secretKey=secretKey } }
  class Config {
    async getRegionsProvider() { return { getRegions:async()=>[{ services:{ up:[{ getValue:()=> 'https://upload.example.test' }] } }] } }
  }
  class BucketManager {
    async stat(bucket, key) { const item=objects.get(key); return item ? { resp:{ statusCode:200 }, data:{ key, fsize:item.length, hash:'etag', mimeType } } : { resp:{ statusCode:612 } } }
    async delete(bucket, key) { calls.deletes.push(key); if ([200,404,612].includes(deleteStatus)) objects.delete(key); return { resp:{ statusCode:deleteStatus } } }
    privateDownloadUrl(domain, key, deadline) { return `${downloadUrl || domain}/${key}?e=${deadline}&token=hidden` }
  }
  class PutPolicy { constructor(options) { this.options=options } uploadToken() { return 'upload-token' } }
  class FormUploader { async put(token, key, body) { calls.uploads.push(key); objects.set(key, Buffer.from(body)); return { resp:{ statusCode:200 }, data:{ key, fsize:Buffer.byteLength(body), hash:'etag' } } } }
  class PutExtra { constructor() { this.mimeType=null } }
  return { auth:{ digest:{ Mac } }, conf:{ Config }, rs:{ BucketManager, PutPolicy }, form_up:{ FormUploader, PutExtra }, objects, calls }
}

function healthFetch({ status = 206, body = HEALTH_BODY, seen } = {}) {
  return async (url, options) => {
    seen?.push({ url, options })
    return {
      status,
      headers:{ get: name => name.toLowerCase() === 'content-range' && status === 206 ? `bytes 0-${HEALTH_BODY.length - 1}/${HEALTH_BODY.length}` : null },
      arrayBuffer:async()=>Buffer.from(body),
    }
  }
}

const config={ access_key:'access', secret_key:'secret', bucket:'bucket', domain:'https://cdn.example.test', region:'z0', private_bucket:'true' }

describe('Qiniu storage provider', () => {
  it('runs upload, metadata read and delete as one healthcheck', async () => {
    const seen=[], sdk=fakeSdk(), provider=new QiniuStorageProvider({ config, sdk, fetch:healthFetch({ seen }) })
    const result=await provider.testConnection()
    expect(result).toEqual({ ok:true, stage:'completed' })
    expect(seen[0].url.startsWith(config.domain)).toBe(true)
    expect(seen[0].options.headers.Range).toBe(`bytes=0-${HEALTH_BODY.length - 1}`)
    expect(sdk.calls.uploads).toHaveLength(1)
    expect(sdk.calls.uploads[0]).toMatch(/^website\/dev\/healthcheck\/[A-Za-z0-9_-]{8,128}\.txt$/)
    expect(sdk.calls.deletes).toEqual([sdk.calls.uploads[0]])
    expect(sdk.objects.size).toBe(0)
  })

  it('binds direct upload tokens to an immutable key and produces short-lived reads', async () => {
    const sdk=fakeSdk(), provider=new QiniuStorageProvider({ config, sdk, clock:()=>1_700_000_000_000 })
    const session=await provider.createDirectUpload({ purpose:'attachment', sizeBytes:123, mimeType:'application/pdf', uploadId:'upload1234' })
    expect(session).toMatchObject({ objectKey:'website/dev/attachment/upload1234', purpose:'attachment', sizeBytes:123, mimeType:'application/pdf' })
    expect(session.uploadUrl).toBe('https://upload.example.test')
    expect(session.token).toBe('upload-token')
    expect(await provider.createReadUrl({ objectKey:session.objectKey }, { ttlSeconds:1 })).toContain(`e=${1_700_000_060}`)
  })

  it('strictly confirms existence, exact size and MIME metadata', async () => {
    const sdk=fakeSdk({ mimeType:'video/mp4' }), provider=new QiniuStorageProvider({ config, sdk })
    const objectKey='website/dev/video/video1234'
    sdk.objects.set(objectKey, Buffer.alloc(4))
    const confirmed=await provider.confirmDirectUpload({ objectKey, purpose:'video', sizeBytes:4, mimeType:'video/mp4' }, { key:objectKey })
    expect(confirmed).toMatchObject({ exists:true, sizeBytes:4, purpose:'video', mimeType:'video/mp4' })
    await expect(provider.confirmDirectUpload({ objectKey, purpose:'video', sizeBytes:3, mimeType:'video/mp4' }, { key:objectKey })).rejects.toMatchObject({ code:'storage_qiniu_object_size_mismatch' })
    await expect(provider.confirmDirectUpload({ objectKey, purpose:'image', sizeBytes:4, mimeType:'image/png' }, { key:objectKey })).rejects.toMatchObject({ code:'storage_qiniu_object_mime_mismatch' })
  })

  it('verifies image magic bytes during direct confirm instead of trusting browser MIME', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const sdk=fakeSdk({ mimeType:'image/png' })
    const objectKey='website/dev/image/image1234'
    const badKey='website/dev/image/image5678'
    const invalid = Buffer.from('not-an-image')
    sdk.objects.set(objectKey, png)
    const provider=new QiniuStorageProvider({ config, sdk, fetch:async url => ({ status:200, arrayBuffer:async()=>url.includes(badKey) ? invalid : png, headers:{ get:()=>null } }) })
    await expect(provider.confirmDirectUpload({ objectKey, purpose:'image', sizeBytes:png.length, mimeType:'image/png' }, { key:objectKey })).resolves.toMatchObject({ purpose:'image', sizeBytes:png.length })
    sdk.objects.set(badKey, invalid)
    await expect(provider.confirmDirectUpload({ objectKey:badKey, purpose:'image', sizeBytes:invalid.length, mimeType:'image/png' }, { key:badKey })).rejects.toMatchObject({ code:'storage_qiniu_object_signature_invalid' })
  })

  it('does not report a green result when cleanup fails', async () => {
    const sdk=fakeSdk({ deleteStatus:500 }), provider=new QiniuStorageProvider({ config, sdk, fetch:healthFetch() })
    await expect(provider.testConnection()).rejects.toMatchObject({ code:'storage_qiniu_cleanup_failed', stage:'object_delete', cleanupFailed:true })
  })

  it('always attempts cleanup after a read failure and rejects a wrong read domain', async () => {
    const failedReadSdk=fakeSdk({ deleteStatus:500 }), failedReadProvider=new QiniuStorageProvider({ config, sdk:failedReadSdk, fetch:healthFetch({ status:503 }) })
    await expect(failedReadProvider.testConnection()).rejects.toMatchObject({ code:'storage_qiniu_cleanup_failed', cleanupFailed:true })
    expect(failedReadSdk.objects.size).toBe(1)
    const wrongDomainSdk=fakeSdk({ downloadUrl:'https://evil.example.test' }), seen=[]
    const wrongDomainProvider=new QiniuStorageProvider({ config, sdk:wrongDomainSdk, fetch:healthFetch({ seen }) })
    await expect(wrongDomainProvider.testConnection()).rejects.toMatchObject({ code:'storage_qiniu_download_failed', stage:'object_read' })
    expect(seen).toHaveLength(0)
    expect(wrongDomainSdk.objects.size).toBe(0)
  })
})
