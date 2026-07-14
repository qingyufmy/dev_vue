import { describe, expect, it } from 'vitest'
import { classifyArticleUrl, getVideoEpisodeIds, hasVideoMedia } from '../public/src/lib/course-media.js'

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

  it('does not iframe empty values or the site homepage', () => {
    expect(classifyArticleUrl('', 'http://192.168.1.254')).toEqual({ mode: 'missing', url: '' })
    expect(classifyArticleUrl('/', 'http://192.168.1.254')).toEqual({ mode: 'missing', url: '' })
    expect(classifyArticleUrl('http://192.168.1.254/', 'http://192.168.1.254')).toEqual({ mode: 'missing', url: '' })
    expect(classifyArticleUrl('javascript:alert(1)', 'http://192.168.1.254')).toEqual({ mode: 'missing', url: '' })
  })

  it('embeds same-origin article paths and opens external articles separately', () => {
    expect(classifyArticleUrl('/articles/test.html', 'https://cnfxtrade.com')).toEqual({
      mode: 'embedded',
      url: '/articles/test.html',
    })
    expect(classifyArticleUrl('https://example.com/article', 'https://cnfxtrade.com')).toEqual({
      mode: 'external',
      url: 'https://example.com/article',
    })
  })
})
