import { describe, expect, it } from 'vitest'
import { getVideoEpisodeIds, hasVideoMedia } from '../public/src/lib/course-media.js'

describe('course video media detection', () => {
  it('does not treat a paid course without media as a video course', () => {
    expect(hasVideoMedia({ id: 1, access_level: 'plus_pro' })).toBe(false)
    expect(getVideoEpisodeIds([{ id: 1, access_level: 'plus_pro' }])).toEqual([])
  })

  it('detects each supported video source flag', () => {
    expect(hasVideoMedia({ hasStreamVideo: true })).toBe(true)
    expect(hasVideoMedia({ hasBilibili: true })).toBe(true)
    expect(hasVideoMedia({ hasYoutube: true })).toBe(true)
  })

  it('returns only episode ids that actually have video media', () => {
    expect(getVideoEpisodeIds([
      { id: 1, access_level: 'plus_pro' },
      { id: 2, hasStreamVideo: true },
      { id: '3', hasBilibili: true },
    ])).toEqual([2, 3])
  })
})
