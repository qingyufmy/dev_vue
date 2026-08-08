import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, readFile, rename, rm, stat as statFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createStorageObjectKey, normalizeStoragePurpose, validateObjectKey, validateStorageUpload } from './storage-policy.js'
import { validateLocalVideoFile } from './video-validator.js'

function asBodyBuffer(body) {
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body === 'string') return Buffer.from(body)
  return null
}

export class LocalStorageProvider {
  constructor({ root } = {}) {
    if (!root) throw new Error('storage_local_root_required')
    this.root = path.resolve(String(root))
    this.provider = 'local'
  }

  resolveObjectPath(objectKey) {
    const key = validateObjectKey(objectKey)
    const resolved = path.resolve(this.root, ...key.split('/'))
    const rootPrefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`
    if (resolved !== this.root && !resolved.startsWith(rootPrefix)) throw new Error('storage_object_key_invalid')
    return { key, resolved }
  }

  async put({ objectKey, key, body, filePath, mimeType = '', overwrite = false } = {}) {
    const target = this.resolveObjectPath(objectKey || key)
    if (body === undefined && !filePath) throw new Error('storage_file_body_required')
    await mkdir(path.dirname(target.resolved), { recursive: true })
    const temporary = `${target.resolved}.upload-${randomUUID()}.tmp`
    try {
      if (filePath) await copyFile(path.resolve(String(filePath)), temporary)
      else await writeFile(temporary, asBodyBuffer(body) ?? body, { flag: 'wx' })
      if (overwrite) {
        await rename(temporary, target.resolved)
      } else {
        // link() fails with EEXIST when another writer won the same object
        // key race. Both paths are in the same directory/filesystem, so the
        // hard-link operation is atomic and never replaces an existing file.
        try { await link(temporary, target.resolved) } catch (error) {
          if (error?.code === 'EEXIST') throw new Error('storage_object_exists')
          throw error
        }
        await rm(temporary, { force: true })
      }
      const info = await statFile(target.resolved)
      return { provider: this.provider, objectKey: target.key, sizeBytes: info.size, mimeType: String(mimeType || '') }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async createDirectUpload({ purpose, objectKey, key, uploadId, sizeBytes = 0, mimeType = '', originalName = '', allowGif = false } = {}) {
    const upload = validateStorageUpload({ purpose, sizeBytes, mimeType, originalName, allowGif })
    const generatedKey = createStorageObjectKey({ purpose:upload.purpose, id:uploadId })
    if ((objectKey || key) && (objectKey || key) !== generatedKey) throw new Error('storage_object_key_invalid')
    const target = this.resolveObjectPath(generatedKey)
    return {
      provider: this.provider,
      mode: 'server',
      objectKey: target.key,
      purpose: upload.purpose,
      sizeBytes: upload.sizeBytes,
      mimeType: upload.mimeType,
      expiresAt: null,
    }
  }

  async confirmDirectUpload(session = {}) {
    let actual
    try { actual = await this.stat(session) } catch (error) {
      if (error?.code === 'ENOENT') throw Object.assign(new Error('storage_object_missing'), { code:'storage_object_missing', stage:'object_verify' })
      throw error
    }
    if (!actual.exists) throw Object.assign(new Error('storage_object_missing'), { code:'storage_object_missing', stage:'object_verify' })
    const expectedSize = Number(session.sizeBytes ?? session.size_bytes)
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || actual.sizeBytes !== expectedSize) {
      throw Object.assign(new Error('storage_object_size_mismatch'), { code:'storage_object_size_mismatch', stage:'object_verify' })
    }
    const purpose = session.purpose ? normalizeStoragePurpose(session.purpose) : null
    const mimeType = String(session.mimeType || '').trim().toLowerCase()
    if (purpose && ['video', 'image'].includes(purpose) && !mimeType) {
      throw Object.assign(new Error('storage_object_mime_mismatch'), { code:'storage_object_mime_mismatch', stage:'object_verify' })
    }
    if (purpose === 'video') {
      const target = this.resolveObjectPath(session.objectKey || session.key)
      return {
        ...actual,
        ...(await validateLocalVideoFile({
          filePath: target.resolved,
          originalName: session.originalName,
          mimeType,
          sizeBytes: expectedSize,
        })),
        purpose,
        sizeBytes: expectedSize,
        mimeType,
      }
    }
    return { ...actual, purpose, sizeBytes:expectedSize, mimeType }
  }

  async createReadUrl(object = {}) {
    const objectKey = object.objectKey || object.key
    validateObjectKey(objectKey)
    const identifier = object.id ?? object.fileId ?? objectKey
    return `/api/storage/files/${encodeURIComponent(String(identifier))}`
  }

  async delete({ objectKey, key } = {}) {
    const target = this.resolveObjectPath(objectKey || key)
    try {
      await rm(target.resolved, { force: false })
      return { provider: this.provider, objectKey: target.key, deleted: true, existed: true }
    } catch (error) {
      if (error?.code === 'ENOENT') return { provider: this.provider, objectKey: target.key, deleted: true, existed: false }
      throw error
    }
  }

  async stat({ objectKey, key, includeHash = false } = {}) {
    const target = this.resolveObjectPath(objectKey || key)
    const info = await statFile(target.resolved)
    const result = { provider: this.provider, objectKey: target.key, exists: true, sizeBytes: info.size, updatedAt: info.mtime.toISOString() }
    if (includeHash) result.sha256 = createHash('sha256').update(await readFile(target.resolved)).digest('hex')
    return result
  }

  read({ objectKey, key, start, end } = {}) {
    const target = this.resolveObjectPath(objectKey || key)
    const options = Number.isInteger(start) || Number.isInteger(end) ? { start, end } : undefined
    return createReadStream(target.resolved, options)
  }
}

export function createLocalStorageProvider(options) {
  return new LocalStorageProvider(options)
}
