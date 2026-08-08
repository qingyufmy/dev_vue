import { describe, expect, it, vi } from 'vitest'
import { blockPrivateVideoStatic, buildSignedVideoUrl, verifySignedVideoUrl } from '../server/video-access.js'

describe('private video access', () => {
  it('builds a short-lived API URL instead of exposing the static upload path', () => {
    const url = buildSignedVideoUrl('/uploads/videos/video_demo.mp4', 7, 1_000_000)
    const parsed = new URL(url, 'http://localhost')
    expect(parsed.pathname).toBe('/api/video-file/video_demo.mp4')
    expect(parsed.searchParams.get('viewer')).toBe('7')
    expect(url).not.toContain('/uploads/videos/')
    expect(verifySignedVideoUrl('video_demo.mp4', Object.fromEntries(parsed.searchParams), 1_000_000)).toBe(7)
  })

  it('rejects tampered and expired signed URLs', () => {
    const url = buildSignedVideoUrl('/uploads/videos/video_demo.mp4', 7, 1_000_000)
    const parsed = new URL(url, 'http://localhost')
    const query = Object.fromEntries(parsed.searchParams)
    expect(verifySignedVideoUrl('other.mp4', query, 1_000_000)).toBeNull()
    const tampered = `${query.signature.slice(0, -1)}${query.signature.endsWith('0') ? '1' : '0'}`
    expect(verifySignedVideoUrl('video_demo.mp4', { ...query, signature:tampered }, 1_000_000)).toBeNull()
    expect(verifySignedVideoUrl('video_demo.mp4', query, 1_000_000 + 2 * 60 * 60 * 1000 + 1000)).toBeNull()
  })

  it('blocks direct static requests to the private video directory', () => {
    const res = { status:vi.fn().mockReturnThis(), json:vi.fn() }
    blockPrivateVideoStatic({}, res)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ ok:false, error:'资源不存在' })
  })
})
