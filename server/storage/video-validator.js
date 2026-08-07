import { open as openFile, stat as statFile } from 'node:fs/promises'
import { execFile as childExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { extname } from 'node:path'

export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const VIDEO_HEADER_MAX_BYTES = 16 * 1024 * 1024
export const VIDEO_MIME_TYPE = 'video/mp4'
const execFileAsync = promisify(childExecFile)

function validationError(code, stage = 'object_verify') {
  const error = new Error(code)
  error.code = code
  error.stage = stage
  return error
}

export function validateVideoMetadata({ originalName, mimeType, sizeBytes } = {}) {
  const name = String(originalName || '').trim()
  const mime = String(mimeType || '').trim().toLowerCase()
  const size = Number(sizeBytes)
  if (!name || extname(name).toLowerCase() !== '.mp4') throw validationError('video_extension_invalid', 'metadata')
  if (mime !== VIDEO_MIME_TYPE) throw validationError('video_mime_invalid', 'metadata')
  if (!Number.isSafeInteger(size) || size <= 0 || size > VIDEO_MAX_BYTES) {
    throw validationError('video_size_invalid', 'metadata')
  }
  return { originalName: name.slice(-255), mimeType: mime, sizeBytes: size, extension: '.mp4' }
}

function readUInt64BE(buffer, offset) {
  const value = buffer.readBigUInt64BE(offset)
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value)
}

/** Parse only top-level MP4 boxes from a bounded prefix. */
export function parseMp4TopLevelBoxes(input, { maxBytes = VIDEO_HEADER_MAX_BYTES } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '')
  if (buffer.length === 0 || buffer.length > maxBytes) throw validationError('video_header_too_large', 'object_read')
  let offset = 0
  let moovOffset = -1
  let mdatOffset = -1
  const boxes = []
  while (offset + 8 <= buffer.length) {
    const boxOffset = offset
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    offset += 8
    if (size === 1) {
      if (offset + 8 > buffer.length) throw validationError('video_mp4_box_truncated', 'object_read')
      size = readUInt64BE(buffer, offset)
      if (!size) throw validationError('video_mp4_box_invalid', 'object_read')
      offset += 8
    } else if (size === 0) {
      if (type === 'mdat') {
        if (moovOffset < 0) throw validationError('video_faststart_invalid', 'object_verify')
        mdatOffset = boxOffset
        boxes.push({ type, offset: boxOffset, size, headerSize: offset - boxOffset })
        return { boxes, moovOffset, mdatOffset }
      }
      // A non-media top-level box with size zero extends to EOF. It is
      // impossible to validate safely in a bounded prefix.
      throw validationError('video_mp4_box_unbounded', 'object_read')
    }
    const headerSize = offset - boxOffset
    // A fast-start file normally has a very large mdat immediately after a
    // complete moov. The bounded prefix intentionally does not contain that
    // payload; the mdat header is enough to prove ordering. Seeing mdat before
    // moov proves the file is not fast-start and is rejected immediately.
    if (type === 'mdat') {
      if (moovOffset < 0) throw validationError('video_faststart_invalid', 'object_verify')
      if (size < headerSize) throw validationError('video_mp4_box_invalid', 'object_read')
      mdatOffset = boxOffset
      boxes.push({ type, offset: boxOffset, size, headerSize })
      return { boxes, moovOffset, mdatOffset }
    }
    if (size < headerSize || boxOffset + size > buffer.length) {
      throw validationError('video_mp4_box_truncated', 'object_read')
    }
    boxes.push({ type, offset: boxOffset, size, headerSize })
    if (type === 'moov' && moovOffset < 0) moovOffset = boxOffset
    if (type === 'mdat' && mdatOffset < 0) mdatOffset = boxOffset
    offset = boxOffset + size
  }
  if (offset !== buffer.length) throw validationError('video_mp4_box_truncated', 'object_read')
  if (moovOffset < 0 || mdatOffset < 0) throw validationError('video_faststart_invalid', 'object_read')
  if (moovOffset > mdatOffset) throw validationError('video_faststart_invalid', 'object_verify')
  return { boxes, moovOffset, mdatOffset }
}

export async function readVideoHeader(filePath, { fsOpen = openFile, maxBytes = VIDEO_HEADER_MAX_BYTES } = {}) {
  let handle
  try {
    handle = await fsOpen(filePath, 'r')
    const buffer = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } catch (error) {
    if (error?.code === 'ENOENT') throw validationError('video_file_missing', 'object_read')
    throw validationError('video_header_read_failed', 'object_read')
  } finally {
    try { await handle?.close() } catch {}
  }
}

function probeStreams(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : []
  const video = streams.find(stream => String(stream?.codec_type || '').toLowerCase() === 'video')
  const audio = streams.find(stream => String(stream?.codec_type || '').toLowerCase() === 'audio')
  if (!video) throw validationError('video_track_missing', 'metadata')
  if (String(video.codec_name || '').toLowerCase() !== 'h264') throw validationError('video_codec_invalid', 'metadata')
  if (Number(video.width) !== 1920 || Number(video.height) !== 1080) throw validationError('video_dimensions_invalid', 'metadata')
  if (!audio) throw validationError('video_audio_missing', 'metadata')
  if (String(audio.codec_name || '').toLowerCase() !== 'aac') throw validationError('video_audio_codec_invalid', 'metadata')
  const formatName = String(probe?.format?.format_name || '').toLowerCase()
  if (!formatName.split(',').includes('mp4')) throw validationError('video_container_invalid', 'metadata')
  const duration = Number(probe?.format?.duration)
  return { durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0 }
}

export async function probeLocalVideo(filePath, { execFileImpl = execFileAsync } = {}) {
  let stdout
  try {
    ({ stdout } = await execFileImpl('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath,
    ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }))
  } catch (error) {
    if (error?.code === 'ENOENT') throw validationError('video_ffprobe_unavailable', 'metadata')
    throw validationError('video_ffprobe_failed', 'metadata')
  }
  let parsed
  try { parsed = JSON.parse(String(stdout || '')) } catch { throw validationError('video_ffprobe_invalid', 'metadata') }
  return probeStreams(parsed)
}

export async function validateLocalVideoFile({ filePath, originalName, mimeType, sizeBytes, execFileImpl, fsOpen, fsStat = statFile } = {}) {
  const stat = await fsStat(filePath).catch(error => {
    if (error?.code === 'ENOENT') throw validationError('video_file_missing', 'object_read')
    throw validationError('video_file_stat_failed', 'object_read')
  })
  const metadata = validateVideoMetadata({ originalName, mimeType, sizeBytes: sizeBytes ?? stat.size })
  if (Number(stat.size) !== metadata.sizeBytes) throw validationError('video_size_mismatch', 'metadata')
  const probe = await probeLocalVideo(filePath, { execFileImpl })
  const header = await readVideoHeader(filePath, { fsOpen })
  const fastStart = parseMp4TopLevelBoxes(header)
  return { ...metadata, ...probe, fastStart }
}

function avinfoStreams(avinfo) {
  const root = avinfo?.data && typeof avinfo.data === 'object' ? avinfo.data : avinfo
  return Array.isArray(root?.streams) ? root.streams : []
}

export function validateQiniuAvinfo(avinfo) {
  const streams = avinfoStreams(avinfo)
  const video = streams.find(stream => String(stream?.codec_type || stream?.type || '').toLowerCase() === 'video')
  const audio = streams.find(stream => String(stream?.codec_type || stream?.type || '').toLowerCase() === 'audio')
  if (!video) throw validationError('video_track_missing', 'metadata')
  if (String(video.codec_name || video.codec || '').toLowerCase() !== 'h264') throw validationError('video_codec_invalid', 'metadata')
  if (Number(video.width) !== 1920 || Number(video.height) !== 1080) throw validationError('video_dimensions_invalid', 'metadata')
  if (!audio) throw validationError('video_audio_missing', 'metadata')
  if (String(audio.codec_name || audio.codec || '').toLowerCase() !== 'aac') throw validationError('video_audio_codec_invalid', 'metadata')
  const formatName = String(avinfo?.format?.format_name || avinfo?.data?.format?.format_name || avinfo?.format_name || '').toLowerCase()
  if (!formatName || !formatName.split(',').includes('mp4')) throw validationError('video_container_invalid', 'metadata')
  const duration = Number(video.duration || avinfo?.format?.duration || avinfo?.data?.format?.duration)
  return { durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0 }
}

export async function validateQiniuVideoObject({ provider, objectKey, originalName, mimeType, sizeBytes, avinfo } = {}) {
  const metadata = validateVideoMetadata({ originalName, mimeType, sizeBytes })
  const stat = await provider.stat({ objectKey })
  if (!stat?.exists) throw validationError('video_object_missing', 'object_verify')
  if (Number(stat.sizeBytes) !== metadata.sizeBytes) throw validationError('video_size_mismatch', 'object_verify')
  const info = await provider.getAvinfo(objectKey, { sizeBytes: metadata.sizeBytes })
  const tracks = validateQiniuAvinfo(avinfo || info)
  const range = await provider.readSignedRange(objectKey, { sizeBytes: metadata.sizeBytes, maxBytes: VIDEO_HEADER_MAX_BYTES })
  const header = Buffer.isBuffer(range?.body) ? range.body : Buffer.from(range?.body || '')
  parseMp4TopLevelBoxes(header)
  return { ...metadata, ...tracks, fastStart: true }
}

export function isSafeVideoSource(value) {
  return value === 'local_mp4' || value === 'qiniu_mp4'
}
