import { describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import {
  parseMp4TopLevelBoxes,
  validateVideoMetadata,
  validateQiniuAvinfo,
  probeLocalVideo,
} from '../../server/storage/video-validator.js'

function box(type, payload = Buffer.alloc(0), sizeOverride) {
  const size = sizeOverride ?? (8 + payload.length)
  const out = Buffer.alloc(8 + payload.length)
  out.writeUInt32BE(size >>> 0, 0)
  out.write(type, 4, 4, 'ascii')
  payload.copy(out, 8)
  return out
}

describe('managed video validation', () => {
  it('accepts a complete moov followed by a large mdat outside the bounded prefix', () => {
    const header = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', Buffer.alloc(32)), box('mdat', Buffer.alloc(0), 0x7fffffff)])
    const parsed = parseMp4TopLevelBoxes(header)
    expect(parsed.moovOffset).toBeLessThan(parsed.mdatOffset)
  })

  it('rejects mdat before moov without downloading the payload', () => {
    const header = Buffer.concat([box('mdat', Buffer.alloc(0), 0x7fffffff)])
    expect(() => parseMp4TopLevelBoxes(header)).toThrowError('video_faststart_invalid')
  })

  it('accepts extended-size mdat after moov', () => {
    const extended = Buffer.alloc(16)
    extended.writeUInt32BE(1, 0);extended.write('mdat', 4, 4, 'ascii');extended.writeBigUInt64BE(BigInt(1024 * 1024 * 1024), 8)
    const parsed = parseMp4TopLevelBoxes(Buffer.concat([box('moov', Buffer.alloc(8)), extended]))
    expect(parsed.mdatOffset).toBeGreaterThan(parsed.moovOffset)
  })

  it('requires exact MP4 metadata and safe size', () => {
    expect(validateVideoMetadata({ originalName: 'lesson.mp4', mimeType: 'video/mp4', sizeBytes: 42 }).extension).toBe('.mp4')
    expect(() => validateVideoMetadata({ originalName: 'lesson.mov', mimeType: 'video/mp4', sizeBytes: 42 })).toThrowError('video_extension_invalid')
    expect(() => validateVideoMetadata({ originalName: 'lesson.mp4', mimeType: '', sizeBytes: 42 })).toThrowError('video_mime_invalid')
    expect(() => validateVideoMetadata({ originalName: 'lesson.mp4', mimeType: 'video/mp4', sizeBytes: 0 })).toThrowError('video_size_invalid')
  })

  it('requires an explicit MP4 container in Qiniu avinfo', () => {
    const tracks = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }] }
    expect(() => validateQiniuAvinfo(tracks)).toThrowError('video_container_invalid')
    expect(validateQiniuAvinfo({ ...tracks, format: { format_name: 'mp4' } })).toEqual({ durationSeconds: 0 })
  })

  it('fails closed when ffprobe is unavailable and accepts strict tracks when mocked', async () => {
    await expect(probeLocalVideo('/private/lesson.mp4', { execFileImpl: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })) })).rejects.toThrowError('video_ffprobe_unavailable')
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      { codec_type: 'audio', codec_name: 'aac' },
    ], format: { format_name: 'mov,mp4,m4a', duration: '12.5' } }) })
    await expect(probeLocalVideo('/private/lesson.mp4', { execFileImpl })).resolves.toEqual({ durationSeconds: 12.5 })
  })
})
