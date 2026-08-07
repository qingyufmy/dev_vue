import { describe, expect, it } from 'vitest'
import { parseVideoRange } from '../../server/routes/video-managed.js'

describe('managed local video ranges', () => {
  it('supports bounded open and suffix ranges', () => {
    expect(parseVideoRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseVideoRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseVideoRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })
  it('rejects invalid, empty and multi-range requests with a 416 marker', () => {
    expect(parseVideoRange('bytes=1000-1001', 1000)).toEqual({ invalid: true })
    expect(parseVideoRange('bytes=99-90', 1000)).toEqual({ invalid: true })
    expect(parseVideoRange('bytes=0-1,2-3', 1000)).toEqual({ invalid: true })
    expect(parseVideoRange('bytes=', 1000)).toEqual({ invalid: true })
  })
})
