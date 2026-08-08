import { describe, expect, it } from 'vitest'
import { QiniuStorageProvider } from '../../server/storage/qiniu-storage-provider.js'

function sdkWithObjects(objects, domain = 'https://cdn.example.test') {
  class Mac { constructor(accessKey, secretKey) { this.accessKey = accessKey; this.secretKey = secretKey } }
  class Config {}
  class BucketManager {
    async stat(_bucket, key) { const value = objects.get(key); return value ? { resp: { statusCode: 200 }, data: { fsize: value.length, mimeType: 'video/mp4' } } : { resp: { statusCode: 612 } } }
    privateDownloadUrl(_domain, key, deadline) { return `${domain}/${key}&e=${deadline}&token=opaque` }
    async delete() { return { resp: { statusCode: 200 } } }
  }
  class FormUploader {}
  class PutExtra {}
  return { auth: { digest: { Mac } }, conf: { Config }, rs: { BucketManager }, form_up: { FormUploader, PutExtra }, objects }
}

const config = { access_key: 'access', secret_key: 'secret', bucket: 'bucket', domain: 'https://cdn.example.test', region: 'z0', private_bucket: 'true' }

function fastStartHeader() {
  const ftyp = Buffer.alloc(16);ftyp.writeUInt32BE(16, 0);ftyp.write('ftyp', 4, 4, 'ascii')
  const moov = Buffer.alloc(16);moov.writeUInt32BE(16, 0);moov.write('moov', 4, 4, 'ascii')
  const mdat = Buffer.alloc(8);mdat.writeUInt32BE(0x7fffffff, 0);mdat.write('mdat', 4, 4, 'ascii')
  return Buffer.concat([ftyp, moov, mdat])
}

describe('Qiniu managed video verification', () => {
  it('uses signed ?avinfo and a real bounded 206 range', async () => {
    const objectKey = 'website/dev/video/video1234'
    const body = fastStartHeader()
    const objects = new Map([[objectKey, body]])
    const seen = []
    const sdk = sdkWithObjects(objects)
    const provider = new QiniuStorageProvider({
      config, sdk,
      fetch: async (url, options) => {
        seen.push({ url, options })
        if (url.includes('?avinfo')) return { status: 200, url, json: async () => ({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }], format: { format_name: 'mp4' } }) }
        return { status: 206, url, headers: { get: name => name === 'accept-ranges' ? 'bytes' : `bytes 0-${body.length - 1}/${body.length}` }, arrayBuffer: async () => body }
      },
    })
    await expect(provider.confirmDirectUpload({ objectKey, purpose: 'video', originalName: 'lesson.mp4', sizeBytes: body.length, mimeType: 'video/mp4' }, { key: objectKey })).resolves.toMatchObject({ purpose: 'video', durationSeconds: 0 })
    expect(seen[0].url).toContain('?avinfo')
    expect(seen[0].url).not.toContain('secret')
    expect(seen[1].options.headers.Range).toMatch(/^bytes=0-/)
  })

  it('rejects 200/full responses and mismatched Content-Range', async () => {
    const objectKey = 'website/dev/video/video1234', body = fastStartHeader(), objects = new Map([[objectKey, body]]), sdk = sdkWithObjects(objects)
    const provider = new QiniuStorageProvider({
      config, sdk,
      avinfo: async () => ({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }], format: { format_name: 'mp4' } }),
      fetch: async url => ({ status: 200, url, headers: { get: () => 'bytes' }, arrayBuffer: async () => body }),
    })
    await expect(provider.confirmDirectUpload({ objectKey, purpose: 'video', originalName: 'lesson.mp4', sizeBytes: body.length, mimeType: 'video/mp4' }, { key: objectKey })).rejects.toMatchObject({ code: 'storage_qiniu_range_invalid' })
  })
})
