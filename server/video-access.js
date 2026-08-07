import crypto from 'crypto'
import { basename } from 'path'
import { JWT_SECRET } from './config.js'

const SIGNED_VIDEO_TTL_SECONDS = 2 * 60 * 60
const MANAGED_VIDEO_TTL_SECONDS = 5 * 60

function normalizedFilename(value) {
  const text = String(value || '').split('?')[0].replaceAll('\\', '/')
  const marker = text.includes('/uploads/videos/')
    ? '/uploads/videos/'
    : text.includes('/api/video-file/') ? '/api/video-file/' : ''
  const candidate = marker ? text.slice(text.indexOf(marker) + marker.length) : text
  const filename = basename(candidate)
  if (!filename || filename !== candidate || !/^[a-zA-Z0-9._-]+$/.test(filename)) return ''
  return filename
}

function signatureFor(filename, viewerId, expires) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(`${filename}:${viewerId}:${expires}`)
    .digest('hex')
}

function managedSignatureFor(streamId, viewerId, expires) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(`managed:${streamId}:${viewerId}:${expires}`)
    .digest('hex')
}

export function buildSignedManagedVideoUrl(streamId, viewerId = 0, now = Date.now()) {
  const id = Number.parseInt(streamId, 10)
  if (!Number.isSafeInteger(id) || id <= 0) return ''
  const viewer = Math.max(0, Number.parseInt(viewerId, 10) || 0)
  const expires = Math.floor(Number(now) / 1000) + MANAGED_VIDEO_TTL_SECONDS
  return `/api/video-file/stored/${id}?viewer=${viewer}&expires=${expires}&signature=${managedSignatureFor(id, viewer, expires)}`
}

export function verifySignedManagedVideoUrl(streamIdValue, query = {}, now = Date.now()) {
  const id = Number.parseInt(streamIdValue, 10)
  const viewer = Number.parseInt(query.viewer, 10)
  const expires = Number.parseInt(query.expires, 10)
  const signature = String(query.signature || '')
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(viewer) || viewer < 0 || !Number.isInteger(expires)) return null
  if (expires < Math.floor(Number(now) / 1000)) return null
  const expected = managedSignatureFor(id, viewer, expires)
  if (signature.length !== expected.length) return null
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? viewer : null
}

export function buildSignedVideoUrl(localPath, viewerId = 0, now = Date.now()) {
  const filename = normalizedFilename(localPath)
  if (!filename) return String(localPath || '')
  const viewer = Math.max(0, Number.parseInt(viewerId, 10) || 0)
  const expires = Math.floor(Number(now) / 1000) + SIGNED_VIDEO_TTL_SECONDS
  const signature = signatureFor(filename, viewer, expires)
  return `/api/video-file/${encodeURIComponent(filename)}?viewer=${viewer}&expires=${expires}&signature=${signature}`
}

export function verifySignedVideoUrl(filenameValue, query = {}, now = Date.now()) {
  const filename = normalizedFilename(filenameValue)
  const viewer = Number.parseInt(query.viewer, 10)
  const expires = Number.parseInt(query.expires, 10)
  const signature = String(query.signature || '')
  if (!filename || !Number.isInteger(viewer) || viewer < 0 || !Number.isInteger(expires)) return null
  if (expires < Math.floor(Number(now) / 1000)) return null
  const expected = signatureFor(filename, viewer, expires)
  if (signature.length !== expected.length) return null
  const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  return valid ? viewer : null
}

export function blockPrivateVideoStatic(req, res) {
  res.status(404).json({ ok:false, error:'资源不存在' })
}
