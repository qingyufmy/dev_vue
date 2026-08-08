import { randomUUID } from 'node:crypto'
import qiniu from 'qiniu'
import { createHealthcheckObjectKey, createStorageObjectKey, normalizeStoragePurpose, validateObjectKey, validateStorageUpload } from './storage-policy.js'
import { detectImageType } from '../image-upload.js'
import { validateQiniuVideoObject } from './video-validator.js'

function statusCode(value) {
  return Number(value?.resp?.statusCode || value?.statusCode || value?.code || value?.response?.statusCode || value?.response?.status || 0)
}

function stageError(code, stage, cause) {
  const error = new Error(code)
  error.code = code
  error.stage = stage
  error.causeCode = cause?.code || cause?.statusCode || null
  return error
}

function boundedExpiry(value = 600) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return 600
  return Math.min(900, Math.max(60, Math.floor(seconds)))
}

function regionEndpoint(regions) {
  const endpoint = regions?.[0]?.services?.up?.[0]
  if (!endpoint) return 'https://up.qiniup.com'
  if (typeof endpoint.getValue === 'function') return endpoint.getValue({ scheme: 'https' })
  if (typeof endpoint === 'string') return endpoint.startsWith('http') ? endpoint : `https://${endpoint}`
  return 'https://up.qiniup.com'
}

export class QiniuStorageProvider {
  constructor({ config, sdk = qiniu, clock = () => Date.now(), fetch:fetchImpl, fetchImpl:alternateFetch, avinfo:avinfoImpl } = {}) {
    if (!config) throw new Error('storage_qiniu_configuration_missing')
    this.config = config
    this.sdk = sdk
    this.clock = clock
    this.fetch = fetchImpl || alternateFetch || globalThis.fetch
    this.avinfo = avinfoImpl
    this.provider = 'qiniu'
    this.mac = new sdk.auth.digest.Mac(config.access_key, config.secret_key)
    this.qiniuConfig = new sdk.conf.Config({ useHttpsDomain: true })
    this.manager = new sdk.rs.BucketManager(this.mac, this.qiniuConfig)
    this.formUploader = new sdk.form_up.FormUploader(this.qiniuConfig)
  }

  async uploadEndpoint() {
    const regionsProvider = await this.qiniuConfig.getRegionsProvider({ bucketName: this.config.bucket, accessKey: this.config.access_key })
    const regions = await regionsProvider.getRegions()
    return regionEndpoint(regions)
  }

  createUploadToken(objectKey, { expires = 600, sizeBytes = 0, mimeType = '' } = {}) {
    validateObjectKey(objectKey)
    const ttl = boundedExpiry(expires)
    const size = Number(sizeBytes)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('storage_file_size_invalid')
    const policy = new this.sdk.rs.PutPolicy({
      scope: `${this.config.bucket}:${objectKey}`,
      insertOnly: 1,
      expires:ttl,
      fsizeLimit: size > 0 ? size : undefined,
      mimeLimit: mimeType ? String(mimeType) : undefined,
    })
    return policy.uploadToken(this.mac)
  }

  async createDirectUpload({ purpose, objectKey, key, sizeBytes = 0, mimeType = '', originalName = '', expires = 600, uploadId = randomUUID(), allowGif = false } = {}) {
    const upload = validateStorageUpload({ purpose, sizeBytes, mimeType, originalName, allowGif })
    const generatedKey = createStorageObjectKey({ purpose:upload.purpose, id: uploadId })
    if ((objectKey || key) && (objectKey || key) !== generatedKey) throw new Error('storage_object_key_invalid')
    const normalizedKey = generatedKey
    validateObjectKey(normalizedKey)
    const ttl = boundedExpiry(expires)
    const token = this.createUploadToken(normalizedKey, { expires:ttl, sizeBytes:upload.sizeBytes, mimeType:upload.mimeType })
    return {
      provider: this.provider,
      objectKey: normalizedKey,
      purpose: upload.purpose,
      sizeBytes: upload.sizeBytes,
      mimeType: upload.mimeType,
      uploadUrl: await this.uploadEndpoint(),
      region: this.config.region || null,
      token,
      expiresAt: new Date(this.clock() + ttl * 1000).toISOString(),
      maxBytes: upload.sizeBytes || null,
    }
  }

  async put({ objectKey, key, body, sizeBytes = 0, mimeType = '' } = {}) {
    const normalizedKey = objectKey || key
    validateObjectKey(normalizedKey)
    if (body === undefined || body === null) throw new Error('storage_file_body_required')
    const token = this.createUploadToken(normalizedKey, { sizeBytes, mimeType, expires: 600 })
    const extra = new this.sdk.form_up.PutExtra()
    extra.mimeType = mimeType || null
    let result
    try {
      result = await this.formUploader.put(token, normalizedKey, body, extra)
    } catch (error) {
      throw stageError('storage_qiniu_upload_failed', 'object_upload', error)
    }
    if (statusCode(result) !== 200 || result?.data?.key !== normalizedKey) throw stageError('storage_qiniu_upload_failed', 'object_upload', result)
    return { provider: this.provider, objectKey: normalizedKey, sizeBytes: Number(result?.data?.fsize || sizeBytes || 0), hash: result?.data?.hash || null }
  }

  async confirmDirectUpload(session = {}, result = {}) {
    const expectedKey = session.objectKey || session.key
    const returnedKey = result.key || result.objectKey || expectedKey
    if (!expectedKey || returnedKey !== expectedKey) throw stageError('storage_qiniu_object_key_mismatch', 'object_verify')
    const actual = await this.stat({ objectKey: expectedKey })
    if (!actual.exists) throw stageError('storage_qiniu_object_missing', 'object_verify')
    const expectedSize = Number(session.sizeBytes ?? session.size_bytes)
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || actual.sizeBytes !== expectedSize) {
      throw stageError('storage_qiniu_object_size_mismatch', 'object_verify')
    }
    const purpose = session.purpose ? normalizeStoragePurpose(session.purpose) : null
    const expectedMime = String(session.mimeType || '').trim().toLowerCase()
    if (purpose && ['video', 'image'].includes(purpose) && !expectedMime) throw stageError('storage_qiniu_object_mime_mismatch', 'object_verify')
    if (expectedMime && String(actual.mimeType || '').trim().toLowerCase() !== expectedMime) {
      throw stageError('storage_qiniu_object_mime_mismatch', 'object_verify')
    }
    // New managed video sessions always persist originalName. Keep the
    // lower-level legacy helper compatible for callers that only requested a
    // size/MIME stat without a complete managed-video metadata envelope.
    if (purpose === 'video' && session.originalName) {
      try {
        return {
          ...actual,
          ...(await validateQiniuVideoObject({
            provider: this,
            objectKey: expectedKey,
            originalName: session.originalName,
            mimeType: expectedMime,
            sizeBytes: expectedSize,
          })),
          purpose,
          sizeBytes: expectedSize,
          mimeType: expectedMime || actual.mimeType || '',
        }
      } catch (error) {
        throw error?.stage ? error : stageError('storage_qiniu_video_verify_failed', 'object_verify', error)
      }
    }
    // A browser supplied MIME/extension is only a hint. For image sessions,
    // read a bounded prefix through the private signed URL and verify the
    // actual file signature before the business row is linked.
    if (purpose === 'image') {
      let readUrl
      try { readUrl = await this.createReadUrl({ objectKey: expectedKey }, { ttlSeconds: 60 }) } catch (error) {
        throw stageError('storage_qiniu_download_failed', 'object_read', error)
      }
      let response
      try {
        if (typeof this.fetch !== 'function') throw new Error('storage_qiniu_fetch_unavailable')
        response = await this.fetch(readUrl, { method:'GET', headers:{ Range:'bytes=0-65535' } })
      } catch (error) {
        throw stageError('storage_qiniu_download_failed', 'object_read', error)
      }
      if (![200, 206].includes(Number(response?.status || 0)) || typeof response?.arrayBuffer !== 'function') {
        throw stageError('storage_qiniu_download_failed', 'object_read', response)
      }
      let prefix
      try { prefix = Buffer.from(await response.arrayBuffer()) } catch (error) {
        throw stageError('storage_qiniu_download_failed', 'object_read', error)
      }
      const imageType = detectImageType(prefix)
      if (!imageType || (expectedMime && imageType.mimeType !== expectedMime)) {
        throw stageError('storage_qiniu_object_signature_invalid', 'object_verify')
      }
    }
    return { ...actual, purpose, sizeBytes:expectedSize, mimeType:expectedMime || actual.mimeType || '' }
  }

  async stat({ objectKey, key } = {}) {
    const normalizedKey = objectKey || key
    validateObjectKey(normalizedKey)
    let result
    try { result = await this.manager.stat(this.config.bucket, normalizedKey) } catch (error) {
      if ([404, 612].includes(statusCode(error))) return { provider: this.provider, objectKey: normalizedKey, exists: false }
      throw stageError('storage_qiniu_stat_failed', 'object_read', error)
    }
    const code = statusCode(result)
    if (code === 612 || code === 404) return { provider: this.provider, objectKey: normalizedKey, exists: false }
    if (code !== 200 || !result?.data) throw stageError('storage_qiniu_stat_failed', 'object_read', result)
    return {
      provider: this.provider,
      objectKey: normalizedKey,
      exists: true,
      sizeBytes: Number(result.data.fsize || 0),
      hash: result.data.hash || null,
      mimeType: result.data.mimeType || result.data.mime_type || '',
      updatedAt: result.data.putTime ? new Date(Number(result.data.putTime) / 10000).toISOString() : null,
    }
  }

  async getAvinfo(objectKey, { sizeBytes } = {}) {
    validateObjectKey(objectKey)
    if (typeof this.avinfo === 'function') {
      try { return await this.avinfo({ bucket: this.config.bucket, objectKey, sizeBytes }) } catch (error) {
        throw stageError('storage_qiniu_avinfo_failed', 'metadata', error)
      }
    }
    const deadline = Math.floor((this.clock() + 60 * 1000) / 1000)
    const endpoint = this.manager.privateDownloadUrl(this.config.domain, `${objectKey}?avinfo`, deadline)
    try {
      const parsed = new URL(endpoint)
      const configured = new URL(this.config.domain)
      if (parsed.protocol !== 'https:' || parsed.origin !== configured.origin) throw new Error('storage_qiniu_download_domain_invalid')
    } catch (error) {
      throw stageError('storage_qiniu_avinfo_failed', 'metadata', error)
    }
    let response
    try {
      if (typeof this.fetch !== 'function') throw new Error('storage_qiniu_fetch_unavailable')
      response = await this.fetch(endpoint, { method: 'GET', headers: { Accept: 'application/json' } })
    } catch (error) {
      throw stageError('storage_qiniu_avinfo_failed', 'metadata', error)
    }
    if (Number(response?.status || 0) !== 200 || (typeof response?.json !== 'function' && typeof response?.arrayBuffer !== 'function')) {
      throw stageError('storage_qiniu_avinfo_failed', 'metadata', response)
    }
    if (response?.url) {
      try {
        if (new URL(response.url).origin !== new URL(this.config.domain).origin) throw new Error('storage_qiniu_download_redirect_invalid')
      } catch (error) { throw stageError('storage_qiniu_avinfo_failed', 'metadata', error) }
    }
    try {
      if (typeof response.arrayBuffer === 'function') {
        const body = Buffer.from(await response.arrayBuffer())
        if (body.length > 512 * 1024) throw new Error('storage_qiniu_avinfo_too_large')
        return JSON.parse(body.toString('utf8'))
      }
      const advertisedLength = Number(response?.headers?.get?.('content-length') || response?.headers?.['content-length'] || 0)
      if (advertisedLength > 512 * 1024) throw new Error('storage_qiniu_avinfo_too_large')
      return await response.json()
    } catch (error) { throw stageError('storage_qiniu_avinfo_failed', 'metadata', error) }
  }

  async readSignedRange(objectKey, { sizeBytes, maxBytes = 16 * 1024 * 1024 } = {}) {
    validateObjectKey(objectKey)
    const total = Number(sizeBytes)
    const limit = Math.min(Math.max(1, Number(maxBytes) || 1), 16 * 1024 * 1024)
    const end = Math.min(total, limit) - 1
    if (!Number.isSafeInteger(total) || total <= 0 || end < 0) throw stageError('storage_qiniu_range_invalid', 'object_read')
    let url
    try { url = await this.createReadUrl({ objectKey }, { ttlSeconds: 60 }) } catch (error) {
      throw stageError('storage_qiniu_download_failed', 'object_read', error)
    }
    let response
    try {
      if (typeof this.fetch !== 'function') throw new Error('storage_qiniu_fetch_unavailable')
      const parsed = new URL(url)
      const configured = new URL(this.config.domain)
      if (parsed.protocol !== 'https:' || parsed.origin !== configured.origin) throw new Error('storage_qiniu_download_domain_invalid')
      response = await this.fetch(url, { method: 'GET', headers: { Range: `bytes=0-${end}` } })
    } catch (error) {
      throw stageError('storage_qiniu_download_failed', 'object_read', error)
    }
    if (Number(response?.status || 0) !== 206 || typeof response?.arrayBuffer !== 'function') {
      throw stageError('storage_qiniu_range_invalid', 'object_read', response)
    }
    if (response?.url) {
      try {
        if (new URL(response.url).origin !== new URL(this.config.domain).origin) throw new Error('storage_qiniu_download_redirect_invalid')
      } catch (error) { throw stageError('storage_qiniu_range_invalid', 'object_read', error) }
    }
    const getHeader = name => response?.headers?.get?.(name) || response?.headers?.[name] || response?.headers?.[name.toLowerCase()] || ''
    if (String(getHeader('accept-ranges')).toLowerCase() !== 'bytes') throw stageError('storage_qiniu_range_invalid', 'object_read')
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(getHeader('content-range')).trim())
    if (!match || Number(match[1]) !== 0 || Number(match[2]) !== end || Number(match[3]) !== total) {
      throw stageError('storage_qiniu_range_invalid', 'object_read')
    }
    let body
    try { body = Buffer.from(await response.arrayBuffer()) } catch (error) {
      throw stageError('storage_qiniu_download_failed', 'object_read', error)
    }
    if (body.length !== end + 1 || body.length > limit) throw stageError('storage_qiniu_range_invalid', 'object_read')
    return { status: 206, body, contentRange: String(getHeader('content-range')), acceptRanges: 'bytes' }
  }

  async createReadUrl(object = {}, { ttlSeconds = 300 } = {}) {
    const objectKey = object.objectKey || object.key
    validateObjectKey(objectKey)
    const ttl = boundedExpiry(ttlSeconds)
    const deadline = Math.floor((this.clock() + ttl * 1000) / 1000)
    return this.manager.privateDownloadUrl(this.config.domain, objectKey, deadline)
  }

  async delete({ objectKey, key } = {}) {
    const normalizedKey = objectKey || key
    validateObjectKey(normalizedKey)
    let result
    try { result = await this.manager.delete(this.config.bucket, normalizedKey) } catch (error) {
      if ([404, 612].includes(statusCode(error))) return { provider: this.provider, objectKey: normalizedKey, deleted: true, existed: false }
      throw stageError('storage_qiniu_delete_failed', 'object_delete', error)
    }
    const code = statusCode(result)
    if (code === 612 || code === 404) return { provider: this.provider, objectKey: normalizedKey, deleted: true, existed: false }
    if (code !== 200) throw stageError('storage_qiniu_delete_failed', 'object_delete', result)
    return { provider: this.provider, objectKey: normalizedKey, deleted: true, existed: true }
  }

  async testConnection() {
    const key = createHealthcheckObjectKey({ id: randomUUID() })
    const body = Buffer.from('aurum-storage-healthcheck', 'utf8')
    let uploaded = false
    let firstError = null
    try {
      // Once an upload is attempted, keep the finally cleanup armed. A
      // provider can return an error after the remote object was accepted,
      // and deleting this random key is idempotent if it was not created.
      uploaded = true
      await this.put({ objectKey: key, body, sizeBytes: body.length, mimeType: 'text/plain' })
      const metadata = await this.stat({ objectKey: key })
      if (!metadata.exists || metadata.sizeBytes !== body.length) throw stageError('storage_qiniu_stat_failed', 'object_read')
      let readUrl
      try {
        readUrl = await this.createReadUrl({ objectKey:key }, { ttlSeconds:600 })
        const signed = new URL(readUrl)
        const configured = new URL(this.config.domain)
        if (signed.protocol !== 'https:' || signed.origin !== configured.origin) throw new Error('storage_qiniu_download_domain_invalid')
      } catch (error) {
        throw stageError('storage_qiniu_download_failed', 'object_read', error)
      }
      let response
      try {
        if (typeof this.fetch !== 'function') throw new Error('storage_qiniu_fetch_unavailable')
        response = await this.fetch(readUrl, { method:'GET', headers:{ Range:`bytes=0-${body.length - 1}` } })
      } catch (error) {
        throw stageError('storage_qiniu_download_failed', 'object_read', error)
      }
      const responseStatus = Number(response?.status || 0)
      if (response?.url) {
        try {
          if (new URL(response.url).origin !== new URL(this.config.domain).origin) throw new Error('storage_qiniu_download_redirect_invalid')
        } catch (error) {
          throw stageError('storage_qiniu_download_failed', 'object_read', error)
        }
      }
      if (![200, 206].includes(responseStatus) || typeof response?.arrayBuffer !== 'function') {
        throw stageError('storage_qiniu_download_failed', 'object_read', response)
      }
      let downloaded
      try { downloaded = Buffer.from(await response.arrayBuffer()) } catch (error) {
        throw stageError('storage_qiniu_download_failed', 'object_read', error)
      }
      if (responseStatus === 206) {
        const contentRange = response.headers?.get?.('content-range') || ''
        const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange)
        const end = Number(match?.[2]), total = Number(match?.[3])
        const validRange = !contentRange
          ? downloaded.equals(body)
          : Boolean(match) && Number(match[1]) === 0 && end === body.length - 1 && total === body.length && downloaded.equals(body)
        if (!validRange) {
          throw stageError('storage_qiniu_download_failed', 'object_read')
        }
      } else if (!downloaded.equals(body)) {
        throw stageError('storage_qiniu_download_failed', 'object_read')
      }
    } catch (error) {
      firstError = error?.stage ? error : stageError('storage_qiniu_connection_test_failed', error?.stage || 'object_upload', error)
    } finally {
      if (uploaded) {
        try {
          await this.delete({ objectKey: key })
        } catch (error) {
          const cleanupError = stageError('storage_qiniu_cleanup_failed', 'object_delete', error)
          cleanupError.cleanupFailed = true
          cleanupError.priorCode = firstError?.code || null
          firstError = cleanupError
        }
      }
    }
    if (firstError) throw firstError
    return { ok: true, stage: 'completed' }
  }
}

export function createQiniuStorageProvider(options) {
  return new QiniuStorageProvider(options)
}
