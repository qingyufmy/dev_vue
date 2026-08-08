import { createHash, randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { stat as statFile } from 'node:fs/promises'
import { queryOne, queryRun, withTransaction } from '../db.js'
import { createStorageObjectKey, normalizeStoragePurpose, normalizeStorageVisibility, validateStorageUpload } from './storage-policy.js'

// Business routes use these stable owner labels rather than accepting an
// arbitrary URL/key from a browser. They are also useful when reconciling
// deleting files without touching unrelated objects.
export const STORED_FILE_OWNERS = Object.freeze({
  COURSE_ATTACHMENT: 'course_attachment',
  COURSE_RESOURCE: 'course_resource',
  POST_IMAGE: 'post_image',
})

function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().slice(0, 255)
}

function safeMime(value) {
  return String(value || '').trim().toLowerCase().slice(0, 128)
}

function uploadMetadata({ purpose, originalName, mimeType, sizeBytes, allowGif = false }) {
  const name = cleanName(originalName)
  const mime = safeMime(mimeType)
  const validation = validateStorageUpload({ purpose, originalName: name, mimeType: mime, sizeBytes, allowGif })
  return { ...validation, originalName: name, mimeType: mime, extension: extname(name).toLowerCase().slice(0, 32) }
}

export function safeStorageError(error, fallback = 'storage_upload_failed') {
  const code = String(error?.code || error?.message || fallback).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80)
  const safe = new Error(code || fallback)
  safe.code = code || fallback
  safe.stage = String(error?.stage || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40) || undefined
  safe.cleanupPending = Boolean(error?.cleanupPending || error?.cleanupFailed)
  return safe
}

export function hashBody(body) {
  if (body === undefined || body === null) return null
  return createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.from(body)).digest('hex')
}

function insertStoredFileSql() {
  return `INSERT INTO stored_files
    (purpose, storage_provider, object_key, original_name, mime_type, extension,
     size_bytes, sha256, visibility, owner_type, owner_id, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
}

export async function loadStoredFile(storedFileId, { includeDeleted = false } = {}) {
  if (!Number.isSafeInteger(Number(storedFileId)) || Number(storedFileId) <= 0) return null
  const status = includeDeleted ? '' : " AND sf.status NOT IN ('deleted', 'failed')"
  return queryOne(`SELECT sf.* FROM stored_files sf WHERE sf.id = ?${status}`, [storedFileId])
}

export async function createMultipartStoredFile({
  storage,
  purpose,
  body,
  filePath,
  sizeBytes,
  originalName,
  mimeType,
  ownerType,
  ownerId,
  createdBy,
  visibility = 'authenticated',
  insertBusiness,
  allowGif = false,
}) {
  let detectedSize = sizeBytes
  if (detectedSize === undefined && filePath) {
    try { detectedSize = Number((await statFile(filePath)).size) } catch { detectedSize = 0 }
  }
  if (detectedSize === undefined) detectedSize = Buffer.isBuffer(body) ? body.length : 0
  const metadata = uploadMetadata({ purpose, originalName, mimeType, sizeBytes: detectedSize, allowGif })
  const provider = storage.configuredProvider(metadata.purpose)
  if (provider === 'qiniu') {
    const error = new Error('storage_direct_upload_required')
    error.code = 'storage_direct_upload_required'
    error.stage = 'session_create'
    throw error
  }
  const objectKey = createStorageObjectKey({ purpose: metadata.purpose, id: randomUUID() })
  let uploaded
  try {
    uploaded = await storage.put({
      purpose: metadata.purpose,
      objectKey,
      body,
      filePath,
      sizeBytes: metadata.sizeBytes,
      mimeType: metadata.mimeType,
      originalName: metadata.originalName,
      allowGif,
    })
    const row = await withTransaction(async run => {
      const result = await run(insertStoredFileSql(), [
        metadata.purpose, provider, objectKey, metadata.originalName, metadata.mimeType,
        metadata.extension, metadata.sizeBytes, hashBody(body), normalizeStorageVisibility(visibility),
         ownerType || null, ownerId || null, 'ready', createdBy || null,
      ])
      const storedFileId = Number(result[0]?.insertId)
      if (!storedFileId) throw new Error('stored_file_insert_failed')
      const business = await insertBusiness(run, { storedFileId, provider, objectKey, metadata })
      await run('UPDATE stored_files SET updated_at = NOW() WHERE id = ?', [storedFileId])
      return { storedFileId, business, provider, objectKey, metadata }
    })
    return row
  } catch (error) {
    // An object written before the DB transaction must never be silently
    // replaced by a local fallback. Cleanup is best effort and the original
    // safe error is returned to the caller.
    if (uploaded) {
      try { await storage.delete({ provider, objectKey }) } catch {}
    }
    throw safeStorageError(error)
  }
}

export async function createDirectStorageSession({
  storage,
  purpose,
  originalName,
  mimeType,
  sizeBytes,
  ownerType,
  ownerId,
  createdBy,
  visibility = 'authenticated',
  expiresSeconds = 600,
  allowGif = false,
}) {
  const metadata = uploadMetadata({ purpose, originalName, mimeType, sizeBytes, allowGif })
  if (storage.configuredProvider(metadata.purpose) !== 'qiniu') {
    const error = new Error('storage_direct_upload_not_required')
    error.code = 'storage_direct_upload_not_required'
    error.stage = 'session_create'
    throw error
  }
  const sessionId = randomUUID()
  const direct = await storage.createDirectUpload({
    purpose: metadata.purpose,
    uploadId: sessionId,
    sizeBytes: metadata.sizeBytes,
    mimeType: metadata.mimeType,
    originalName: metadata.originalName,
    allowGif,
    expires: expiresSeconds,
  })
  const provider = direct.provider
  const expiresAt = direct.expiresAt || new Date(Date.now() + Math.min(900, Math.max(60, Number(expiresSeconds) || 600)) * 1000).toISOString()
  try {
    const storedFileId = await withTransaction(async run => {
      const [storedResult] = await run(insertStoredFileSql(), [
        metadata.purpose, provider, direct.objectKey, metadata.originalName, metadata.mimeType,
        metadata.extension, metadata.sizeBytes, null, normalizeStorageVisibility(visibility),
         ownerType || null, ownerId || null, 'uploading', createdBy || null,
      ])
      const id = Number(storedResult?.insertId)
      if (!id) throw new Error('stored_file_insert_failed')
      await run(`INSERT INTO storage_upload_sessions
        (id, stored_file_id, provider, purpose, object_key, original_name, mime_type,
         size_bytes, owner_type, owner_id, created_by, status, expires_at, config_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [
        sessionId, id, provider, metadata.purpose, direct.objectKey, metadata.originalName,
        metadata.mimeType, metadata.sizeBytes, ownerType || null, ownerId || null,
        createdBy || null, expiresAt.slice(0, 19).replace('T', ' '), storage.config?.configVersion || null,
      ])
      return id
    })
    return { ...direct, sessionId, storedFileId, expiresAt, provider, purpose: metadata.purpose, sizeBytes: metadata.sizeBytes, mimeType: metadata.mimeType }
  } catch (error) {
    try { await storage.delete({ provider, objectKey: direct.objectKey }) } catch {}
    throw safeStorageError(error, 'storage_session_create_failed')
  }
}

function sessionExpired(expiresAt) {
  const parsed = Date.parse(String(expiresAt || '').replace(' ', 'T') + (String(expiresAt || '').includes('Z') ? '' : 'Z'))
  return !Number.isFinite(parsed) || parsed <= Date.now()
}

export async function confirmDirectStorageSession({ storage, sessionId, createdBy, result = {}, validateSession, insertBusiness }) {
  const session = await queryOne(`SELECT s.*, sf.status AS stored_file_status
    FROM storage_upload_sessions s INNER JOIN stored_files sf ON sf.id = s.stored_file_id
    WHERE s.id = ?`, [sessionId])
  if (!session) throw Object.assign(new Error('storage_session_not_found'), { code: 'storage_session_not_found', stage: 'session_lookup' })
  if (session.created_by && Number(session.created_by) !== Number(createdBy)) throw Object.assign(new Error('storage_session_forbidden'), { code: 'storage_session_forbidden', stage: 'session_lookup' })
  if (session.status !== 'pending') throw Object.assign(new Error('storage_session_not_pending'), { code: 'storage_session_not_pending', stage: 'session_lookup' })
  if (sessionExpired(session.expires_at)) throw Object.assign(new Error('storage_session_expired'), { code: 'storage_session_expired', stage: 'session_lookup' })
  if (validateSession) await validateSession(session)
  if (storage.config?.configVersion && session.config_version && storage.config.configVersion !== session.config_version) {
    throw Object.assign(new Error('storage_session_config_changed'), { code: 'storage_session_config_changed', stage: 'session_lookup' })
  }
  let actual
  try {
    actual = await storage.confirmDirectUpload({
      provider: session.provider,
      objectKey: session.object_key,
      purpose: session.purpose,
      sizeBytes: Number(session.size_bytes),
      mimeType: session.mime_type,
      originalName: session.original_name,
    }, { ...result, key: session.object_key, objectKey: session.object_key })
    const completed = await withTransaction(async run => {
      const [updated] = await run(`UPDATE storage_upload_sessions SET status = 'confirmed', confirmed_at = NOW() WHERE id = ? AND status = 'pending'`, [session.id])
      if (!updated?.affectedRows) throw new Error('storage_session_race')
      await run(`UPDATE stored_files SET status = 'ready', size_bytes = ?, mime_type = ?, updated_at = NOW() WHERE id = ? AND status = 'uploading'`, [
        Number(actual.sizeBytes), String(actual.mimeType || session.mime_type || '').slice(0, 128), session.stored_file_id,
      ])
      const business = await insertBusiness(run, {
        storedFileId: Number(session.stored_file_id),
        provider: session.provider,
        objectKey: session.object_key,
        actual,
        metadata: {
          originalName: session.original_name,
          mimeType: session.mime_type,
          extension: extname(session.original_name || '').toLowerCase(),
          sizeBytes: Number(session.size_bytes),
          purpose: session.purpose,
        },
      })
      return { storedFileId: Number(session.stored_file_id), business, provider: session.provider, objectKey: session.object_key, actual }
    })
    return completed
  } catch (error) {
    const safe = safeStorageError(error, 'storage_confirm_failed')
    // Any confirmation error can race a different request that commits the
    // same session while this request is unwinding (for example, a business
    // link insert failure after the conditional status update). Re-read
    // before changing state or deleting the remote object; never let the
    // losing request remove an object already linked by the winner.
    const current = await queryOne(`SELECT s.status, sf.status AS stored_file_status
      FROM storage_upload_sessions s INNER JOIN stored_files sf ON sf.id = s.stored_file_id WHERE s.id = ?`, [session.id])
    if (current?.status === 'confirmed' || current?.stored_file_status === 'ready') {
      const duplicate = new Error('storage_session_already_confirmed')
      duplicate.code = 'storage_session_already_confirmed'
      duplicate.stage = 'session_lookup'
      throw duplicate
    }
    try { await withTransaction(async run => {
      await run(`UPDATE storage_upload_sessions SET status = 'failed' WHERE id = ? AND status = 'pending'`, [session.id])
      await run(`UPDATE stored_files SET status = 'failed', updated_at = NOW() WHERE id = ? AND status = 'uploading'`, [session.stored_file_id])
    }) } catch {}
    // Remote objects are cleaned only by their provider and never copied to
    // local storage. Keep failed state if provider cleanup itself fails.
    try { await storage.delete({ provider: session.provider, objectKey: session.object_key }) } catch (cleanupError) {
      safe.cleanupPending = true
      try { await queryRun(`UPDATE stored_files SET status = 'deleting', updated_at = NOW() WHERE id = ?`, [session.stored_file_id]) } catch {}
      safe.code = 'storage_confirm_cleanup_pending'
      safe.stage = cleanupError?.stage || safe.stage
    }
    throw safe
  }
}

export async function markStoredFileDeleting(storedFileId) {
  return queryRun('UPDATE stored_files SET status = \'deleting\', updated_at = NOW() WHERE id = ?', [storedFileId])
}
