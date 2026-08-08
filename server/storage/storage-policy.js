import { randomUUID } from 'node:crypto'

export const STORAGE_PROVIDERS = Object.freeze(['local', 'qiniu'])
export const STORAGE_PURPOSES = Object.freeze(['video', 'attachment', 'image', 'resource'])
export const STORAGE_VISIBILITIES = Object.freeze(['public', 'authenticated', 'membership'])

const PURPOSE_POLICIES = Object.freeze({
  video: Object.freeze({ maxBytes: 2 * 1024 * 1024 * 1024, extensions: ['.mp4'], mimeTypes: ['video/mp4'] }),
  attachment: Object.freeze({ maxBytes: 100 * 1024 * 1024, extensions: [], mimeTypes: [] }),
  image: Object.freeze({ maxBytes: 20 * 1024 * 1024, extensions: ['.jpg', '.jpeg', '.png', '.webp'], mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] }),
  resource: Object.freeze({ maxBytes: 100 * 1024 * 1024, extensions: [], mimeTypes: [] }),
})

export function normalizeStoragePurpose(value) {
  const purpose = String(value || '').trim().toLowerCase()
  if (!STORAGE_PURPOSES.includes(purpose)) throw new Error('storage_purpose_invalid')
  return purpose
}

export function normalizeStorageProvider(value) {
  const provider = String(value || '').trim().toLowerCase()
  if (!STORAGE_PROVIDERS.includes(provider)) throw new Error('storage_provider_invalid')
  return provider
}

export function normalizeStorageVisibility(value = 'authenticated') {
  const visibility = String(value || '').trim().toLowerCase()
  if (!STORAGE_VISIBILITIES.includes(visibility)) throw new Error('storage_visibility_invalid')
  return visibility
}

export function getStoragePolicy(purpose) {
  return PURPOSE_POLICIES[normalizeStoragePurpose(purpose)]
}

export function validateObjectKey(value) {
  const key = String(value || '')
  if (!key || key.length > 512 || key.includes('\\') || key.startsWith('/') || key.includes('\u0000')) {
    throw new Error('storage_object_key_invalid')
  }
  const parts = key.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part))) throw new Error('storage_object_key_invalid')
  if (parts.some(part => /[\u0000-\u001f\u007f]/.test(part))) throw new Error('storage_object_key_invalid')
  return key
}

export function createStorageObjectKey({ purpose, environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev', id = randomUUID() } = {}) {
  const normalizedPurpose = normalizeStoragePurpose(purpose)
  const safeEnvironment = String(environment || 'dev').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  const safeId = String(id || '').trim()
  if (!safeEnvironment || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(safeEnvironment) || !/^[A-Za-z0-9_-]{8,128}$/.test(safeId)) {
    throw new Error('storage_object_key_invalid')
  }
  return validateObjectKey(`website/${safeEnvironment}/${normalizedPurpose}/${safeId}`)
}

export function createHealthcheckObjectKey({ environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev', id = randomUUID() } = {}) {
  const safeEnvironment = String(environment || 'dev').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  const safeId = String(id || '').trim()
  if (!safeEnvironment || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(safeEnvironment) || !/^[A-Za-z0-9_-]{8,128}$/.test(safeId)) {
    throw new Error('storage_object_key_invalid')
  }
  return validateObjectKey(`website/${safeEnvironment}/healthcheck/${safeId}.txt`)
}

export function validateStorageUpload({ purpose, mimeType = '', sizeBytes = 0, originalName = '', allowGif = false } = {}) {
  const normalizedPurpose = normalizeStoragePurpose(purpose)
  const policy = getStoragePolicy(normalizedPurpose)
  const size = Number(sizeBytes)
  if (!Number.isSafeInteger(size) || size < 0 || size > policy.maxBytes) throw new Error('storage_file_size_invalid')
  const mime = String(mimeType || '').trim().toLowerCase()
  const extension = String(originalName || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || ''
  const mimeTypes = allowGif && normalizedPurpose === 'image' ? [...policy.mimeTypes, 'image/gif'] : policy.mimeTypes
  const extensions = allowGif && normalizedPurpose === 'image' ? [...policy.extensions, '.gif'] : policy.extensions
  if (mimeTypes.length && (!mime || !mimeTypes.includes(mime))) throw new Error('storage_mime_type_invalid')
  if (extensions.length && (!extension || !extensions.includes(extension))) throw new Error('storage_extension_invalid')
  return { purpose: normalizedPurpose, mimeType: mime, sizeBytes: size, extension }
}
