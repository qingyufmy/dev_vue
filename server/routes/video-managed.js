import { Router } from 'express'
import multer from 'multer'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { getStorageLocalRoot } from '../storage/storage-config.js'
import { createStorageService } from '../storage/storage-service.js'
import {
  createDirectStorageSession,
  createMultipartStoredFile,
  confirmDirectStorageSession,
  loadStoredFile,
  safeStorageError,
} from '../storage/stored-file-service.js'
import { validateLocalVideoFile, isSafeVideoSource } from '../storage/video-validator.js'
import { queryOne, queryRun, withTransaction } from '../db.js'
import { authMiddleware, optionalAuth, adminOnly } from '../middleware/auth.js'
import { canAccessMembershipLevel, decorateMembership } from '../membership.js'
import { buildSignedManagedVideoUrl, verifySignedManagedVideoUrl } from '../video-access.js'

const router = Router()
const incomingDir = join(getStorageLocalRoot(), 'incoming-video')
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { mkdir(incomingDir, { recursive: true }).then(() => cb(null, incomingDir)).catch(cb) },
    filename: (_req, file, cb) => cb(null, `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.mp4`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (String(file.mimetype || '').toLowerCase() !== 'video/mp4' || !/\.mp4$/i.test(String(file.originalname || ''))) {
      const error = new Error('video_metadata_invalid')
      error.code = 'video_metadata_invalid'
      return cb(error)
    }
    cb(null, true)
  },
})

function jsonError(res, error, fallback = 'video_operation_failed') {
  const safe = safeStorageError(error, fallback)
  const status = safe.code === 'storage_direct_upload_required' ? 409 : safe.code.endsWith('_forbidden') ? 403 : 400
  return res.status(status).json({ ok: false, error: safe.code, stage: safe.stage || undefined })
}

function episodeNumber(value) {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function assertEpisode(episodeId) {
  const course = await queryOne('SELECT episode_id, access_level FROM courses WHERE episode_id = ?', [episodeId])
  if (!course) throw Object.assign(new Error('video_episode_not_found'), { code: 'video_episode_not_found', stage: 'business_link' })
  return course
}

async function linkManagedVideo(run, { episodeId, storedFileId, provider, objectKey, source, metadata, accessLevel, title, durationSeconds }) {
  const [existingRows] = await run('SELECT * FROM video_streams WHERE episode_id = ? FOR UPDATE', [episodeId])
  const existing = existingRows?.[0]
  let oldStoredFile = null
  if (existing?.stored_file_id && Number(existing.stored_file_id) !== Number(storedFileId)) {
    const [oldRows] = await run('SELECT * FROM stored_files WHERE id = ? FOR UPDATE', [existing.stored_file_id])
    oldStoredFile = oldRows?.[0] || null
    await run("UPDATE stored_files SET status = 'deleting', updated_at = NOW() WHERE id = ? AND status NOT IN ('deleted', 'failed')", [existing.stored_file_id])
  }
  const titleValue = String(title || metadata?.originalName || '').slice(0, 500)
  const access = String(accessLevel || 'plus_pro').slice(0, 20)
  const duration = Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : 0
  if (existing) {
    await run(`UPDATE video_streams SET stored_file_id = ?, video_source = ?, local_path = '', qiniu_key = '',
      file_size = ?, duration = ?, title = ?, access_level = ? WHERE id = ?`,
    [storedFileId, source, Number(metadata?.sizeBytes || 0), duration, titleValue, access, existing.id])
  } else {
    await run(`INSERT INTO video_streams
      (episode_id, stored_file_id, video_source, bilibili_id, local_path, qiniu_key,
       file_size, duration, title, access_level)
      VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?)`,
    [episodeId, storedFileId, source, Number(metadata?.sizeBytes || 0), duration, titleValue, access])
  }
  await run(`UPDATE courses SET has_stream_video = 1, local_video_path = '', access_level = ?, updated_at = NOW() WHERE episode_id = ?`, [access, episodeId])
  return { oldStoredFile, videoSource: source, storedFileId: Number(storedFileId), provider, objectKey, durationSeconds: duration }
}

async function cleanupReplacedStoredFile(storage, oldStoredFile) {
  if (!oldStoredFile?.id || !oldStoredFile.object_key || !oldStoredFile.storage_provider) return null
  try {
    await storage.delete({ provider: oldStoredFile.storage_provider, objectKey: oldStoredFile.object_key })
    await queryRun("UPDATE stored_files SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'deleting'", [oldStoredFile.id])
    return null
  } catch (error) {
    await queryRun("UPDATE stored_files SET status = 'deleting', updated_at = NOW() WHERE id = ?", [oldStoredFile.id]).catch(() => {})
    return safeStorageError(Object.assign(error, { cleanupPending: true }), 'video_old_object_cleanup_pending')
  }
}

function accessDenied(res) {
  return res.status(403).json({ ok: false, error: 'video_membership_required' })
}

// Managed video playback has an explicit source. Rows without that source
// deliberately fall through to the legacy handler in video.js.
router.get('/video-storage-provider', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const storage = await createStorageService()
    const provider = storage.configuredProvider('video')
    return res.json({ ok: true, provider, videoSource: provider === 'qiniu' ? 'qiniu_mp4' : 'local_mp4', expiresSeconds: 30 })
  } catch (error) { return jsonError(res, error, 'video_provider_lookup_failed') }
})

router.post('/video-upload-session', authMiddleware, adminOnly, async (req, res) => {
  try {
    const episodeId = episodeNumber(req.body?.episodeId)
    if (!episodeId) throw Object.assign(new Error('video_episode_invalid'), { code: 'video_episode_invalid', stage: 'session_create' })
    await assertEpisode(episodeId)
    const storage = await createStorageService()
    const session = await createDirectStorageSession({
      storage, purpose: 'video', originalName: req.body?.originalName, mimeType: req.body?.mimeType,
      sizeBytes: req.body?.sizeBytes, ownerType: 'video_stream', ownerId: episodeId, createdBy: req.user.id,
      visibility: 'membership', expiresSeconds: 900,
    })
    return res.json({ ok: true, ...session, videoSource: 'qiniu_mp4', uploadPhase: 'uploading', resumable: true })
  } catch (error) { return jsonError(res, error, 'video_session_create_failed') }
})

// A browser may keep only this opaque session id in sessionStorage. On a page
// reload it can obtain a fresh short-lived upload token without persisting an
// AK/SK or token. The original qiniu connection fingerprint remains bound to
// the session so a bucket/credential change fails closed.
router.get('/video-upload-session/:sessionId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || '').trim()
    const session = await queryOne('SELECT * FROM storage_upload_sessions WHERE id = ? AND purpose = \'video\'', [sessionId])
    if (!session || session.owner_type !== 'video_stream') throw Object.assign(new Error('storage_session_not_found'), { code: 'storage_session_not_found', stage: 'session_lookup' })
    if (Number(session.created_by) !== Number(req.user.id)) throw Object.assign(new Error('storage_session_forbidden'), { code: 'storage_session_forbidden', stage: 'session_lookup' })
    if (session.status !== 'pending') throw Object.assign(new Error('storage_session_not_pending'), { code: 'storage_session_not_pending', stage: 'session_lookup' })
    const expiresAt = Date.parse(String(session.expires_at || '').replace(' ', 'T') + (String(session.expires_at || '').includes('Z') ? '' : 'Z'))
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw Object.assign(new Error('storage_session_expired'), { code: 'storage_session_expired', stage: 'session_lookup' })
    const storage = await createStorageService()
    if (storage.config?.configVersion && session.config_version && storage.config.configVersion !== session.config_version) {
      throw Object.assign(new Error('storage_session_config_changed'), { code: 'storage_session_config_changed', stage: 'session_lookup' })
    }
    const provider = storage.providerNamed('qiniu')
    const direct = await provider.createDirectUpload({
      purpose: 'video', objectKey: session.object_key, uploadId: session.id,
      sizeBytes: Number(session.size_bytes), mimeType: session.mime_type, originalName: session.original_name, expires: 900,
    })
    return res.json({ ok: true, ...direct, sessionId, storedFileId: Number(session.stored_file_id), videoSource: 'qiniu_mp4', uploadPhase: 'uploading', resumable: true })
  } catch (error) { return jsonError(res, error, 'video_session_resume_failed') }
})

router.post('/video-upload-confirm', authMiddleware, adminOnly, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || '').trim()
    if (!sessionId) throw Object.assign(new Error('storage_session_not_found'), { code: 'storage_session_not_found', stage: 'session_lookup' })
    const session = await queryOne('SELECT * FROM storage_upload_sessions WHERE id = ? AND purpose = \'video\'', [sessionId])
    if (!session || session.owner_type !== 'video_stream') throw Object.assign(new Error('storage_session_not_found'), { code: 'storage_session_not_found', stage: 'session_lookup' })
    if (Number(session.created_by) !== Number(req.user.id)) throw Object.assign(new Error('storage_session_forbidden'), { code: 'storage_session_forbidden', stage: 'session_lookup' })
    const episodeId = episodeNumber(session.owner_id)
    await assertEpisode(episodeId)
    const storage = await createStorageService()
    const result = await confirmDirectStorageSession({
      storage, sessionId, createdBy: req.user.id,
      insertBusiness: (run, context) => linkManagedVideo(run, {
        episodeId, storedFileId: context.storedFileId, provider: context.provider, objectKey: context.objectKey,
        source: 'qiniu_mp4', metadata: context.metadata, accessLevel: req.body?.accessLevel,
        title: req.body?.title, durationSeconds: context.actual?.durationSeconds,
      }),
    })
    const cleanup = await cleanupReplacedStoredFile(storage, result.business?.oldStoredFile)
    if (cleanup) return res.status(502).json({ ok: false, error: cleanup.code, cleanupPending: true })
    return res.json({ ok: true, uploadPhase: 'confirmed', publishable: true, videoSource: 'qiniu_mp4', ...result.business })
  } catch (error) { return jsonError(res, error, 'video_confirm_failed') }
})

// Local uploads are accepted only when the effective video provider is local.
// The provider preflight runs before multer, so a qiniu configuration cannot
// receive a duplicate full multipart upload at this endpoint.
router.post('/video-upload', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const storage = await createStorageService()
    const managedEpisode = episodeNumber(req.headers['x-video-episode'] || req.query.episodeId)
    if (storage.configuredProvider('video') !== 'local') {
      const error = Object.assign(new Error('storage_direct_upload_required'), { code: 'storage_direct_upload_required', stage: 'provider_preflight' })
      return jsonError(res, error)
    }
    if (!managedEpisode) return next()
    req.videoStorage = storage
    return next()
  } catch (error) { return jsonError(res, error, 'video_provider_lookup_failed') }
}, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw Object.assign(new Error('video_file_required'), { code: 'video_file_required', stage: 'metadata' })
    const episodeId = episodeNumber(req.body?.episodeId)
    if (!episodeId) throw Object.assign(new Error('video_episode_invalid'), { code: 'video_episode_invalid', stage: 'business_link' })
    await assertEpisode(episodeId)
    const validation = await validateLocalVideoFile({ filePath: req.file.path, originalName: req.file.originalname, mimeType: req.file.mimetype, sizeBytes: req.file.size })
    const storage = req.videoStorage || await createStorageService()
    const result = await createMultipartStoredFile({
      storage, purpose: 'video', filePath: req.file.path, sizeBytes: req.file.size,
      originalName: req.file.originalname, mimeType: req.file.mimetype, ownerType: 'video_stream', ownerId: episodeId,
      createdBy: req.user.id, visibility: 'membership',
      insertBusiness: (run, context) => linkManagedVideo(run, {
        episodeId, storedFileId: context.storedFileId, provider: context.provider, objectKey: context.objectKey,
        source: 'local_mp4', metadata: context.metadata, accessLevel: req.body?.accessLevel,
        title: req.body?.title, durationSeconds: validation.durationSeconds,
      }),
    })
    const cleanup = await cleanupReplacedStoredFile(storage, result.business?.oldStoredFile)
    if (cleanup) return res.status(502).json({ ok: false, error: cleanup.code, cleanupPending: true })
    return res.json({ ok: true, uploadPhase: 'confirmed', publishable: true, videoSource: 'local_mp4', storedFileId: result.storedFileId, durationSeconds: validation.durationSeconds, ...result.business })
  } catch (error) { return jsonError(res, error, 'video_upload_failed') } finally { if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {}) }
})

export function parseVideoRange(value, size) {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim())
  if (!match || (!match[1] && !match[2])) return { invalid: true }
  if (match[1] && match[2] && String(value).includes(',')) return { invalid: true }
  let start = match[1] ? Number(match[1]) : null
  let end = match[2] ? Number(match[2]) : null
  if (start === null) {
    const suffix = Number(end)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, size - suffix); end = size - 1
  } else {
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { invalid: true }
    end = end === null ? size - 1 : Number(end)
    if (!Number.isSafeInteger(end) || end < start) return { invalid: true }
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

router.get('/video-file/stored/:streamId', optionalAuth, async (req, res) => {
  try {
    const streamId = Number(req.params.streamId)
    if (!Number.isSafeInteger(streamId) || streamId <= 0) return res.status(400).json({ ok: false, error: 'video_stream_invalid' })
    const signedViewerId = verifySignedManagedVideoUrl(streamId, req.query)
    if (signedViewerId === null) return res.status(401).json({ ok: false, error: 'video_url_invalid' })
    if (req.user && Number(req.user.id || 0) !== Number(signedViewerId) && req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'video_url_viewer_mismatch' })
    if (!req.user && signedViewerId > 0) {
      const user = await queryOne(`SELECT id, role, plan, plan_expires_at,
        (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired
        FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [signedViewerId])
      if (!user) return res.status(401).json({ ok: false, error: 'video_viewer_invalid' })
      req.user = decorateMembership(user)
    }
    const row = await queryOne(`SELECT vs.*, sf.object_key, sf.storage_provider, sf.size_bytes, sf.mime_type,
      c.access_level AS course_access_level FROM video_streams vs
      INNER JOIN stored_files sf ON sf.id = vs.stored_file_id
      INNER JOIN courses c ON c.episode_id = vs.episode_id
      WHERE vs.id = ? AND vs.video_source = 'local_mp4' AND sf.status = 'ready'`, [streamId])
    if (!row) return res.status(404).json({ ok: false, error: 'video_object_unavailable' })
    if (!canAccessMembershipLevel(req.user, row.access_level || row.course_access_level || 'free')) return accessDenied(res)
    const storage = await createStorageService()
    const provider = storage.providerNamed('local', row)
    const metadata = await provider.stat({ objectKey: row.object_key })
    const size = Number(metadata.sizeBytes)
    const range = parseVideoRange(req.headers.range, size)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Type', 'video/mp4')
    if (range?.invalid) {
      res.setHeader('Content-Range', `bytes */${size}`)
      return res.status(416).end()
    }
    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    if (range) {
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    } else res.status(200)
    res.setHeader('Content-Length', end - start + 1)
    return provider.read({ objectKey: row.object_key, start, end }).pipe(res)
  } catch (error) { return jsonError(res, error, 'video_file_failed') }
})

router.delete('/video-stream', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const episodeId = episodeNumber(req.query.episode)
    if (!episodeId) return res.status(400).json({ ok: false, error: 'video_episode_invalid' })
    const stream = await queryOne('SELECT * FROM video_streams WHERE episode_id = ?', [episodeId])
    if (!stream || !isSafeVideoSource(stream.video_source) || !stream.stored_file_id) {
      const pending = await queryOne("SELECT * FROM stored_files WHERE purpose = 'video' AND owner_type = 'video_stream' AND owner_id = ? AND status = 'deleting' ORDER BY updated_at DESC LIMIT 1", [episodeId])
      if (!pending) return next()
      const storage = await createStorageService()
      try {
        await storage.delete({ provider: pending.storage_provider, objectKey: pending.object_key })
        await queryRun("UPDATE stored_files SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'deleting'", [pending.id])
        return res.json({ ok: true, retried: true })
      } catch { return res.status(502).json({ ok: false, error: 'video_object_cleanup_pending', cleanupPending: true }) }
    }
    const storage = await createStorageService()
    const result = await withTransaction(async run => {
      const [lockedRows] = await run('SELECT * FROM video_streams WHERE episode_id = ? FOR UPDATE', [episodeId])
      const locked = lockedRows?.[0]
      if (!locked?.stored_file_id) return { stored: null }
      const [storedRows] = await run('SELECT * FROM stored_files WHERE id = ? FOR UPDATE', [locked.stored_file_id])
      const stored = storedRows?.[0] || null
      await run("UPDATE stored_files SET status = 'deleting', updated_at = NOW() WHERE id = ? AND status NOT IN ('deleted', 'failed')", [locked.stored_file_id])
      await run('DELETE FROM video_streams WHERE id = ?', [locked.id])
      await run("UPDATE courses SET has_stream_video = CASE WHEN COALESCE(bilibili_id, '') <> '' OR COALESCE(youtube_id, '') <> '' OR COALESCE(local_video_path, '') <> '' THEN 1 ELSE 0 END, local_video_path = '', updated_at = NOW() WHERE episode_id = ?", [episodeId])
      return { stored }
    })
    if (!result.stored) return res.json({ ok: true, idempotent: true })
    try {
      await storage.delete({ provider: result.stored.storage_provider, objectKey: result.stored.object_key })
      await queryRun("UPDATE stored_files SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'deleting'", [result.stored.id])
      return res.json({ ok: true })
    } catch (error) {
      await queryRun("UPDATE stored_files SET status = 'deleting', updated_at = NOW() WHERE id = ?", [result.stored.id]).catch(() => {})
      return res.status(502).json({ ok: false, error: 'video_object_cleanup_pending', cleanupPending: true })
    }
  } catch (error) { return jsonError(res, error, 'video_delete_failed') }
})

export default router
