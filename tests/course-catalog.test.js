import { describe, expect, it } from 'vitest'
import { getCoursesForCategory } from '../public/src/lib/course-catalog.js'
import { categories } from '../public/src/data/episodes.js'

describe('course catalog categories', () => {
  const courses = [
    { id: 1, category: 'morning', contentType: 'video', createdAt: '2026-07-13T01:00:00Z' },
    { id: 2, category: 'morning', contentType: 'article', createdAt: '2026-07-14T01:00:00Z' },
    { id: 3, category: 'indicator', contentType: 'video', createdAt: '2026-07-14T02:00:00Z' },
  ]

  it('uses the selected category regardless of content type', () => {
    expect(getCoursesForCategory(courses, 'morning').map(course => course.id)).toEqual([2, 1])
    expect(getCoursesForCategory(courses, 'indicator').map(course => course.id)).toEqual([3])
  })

  it('does not treat all as a synthetic video category', () => {
    expect(getCoursesForCategory(courses, 'all')).toEqual([])
    expect(categories).toEqual([
      { id: 'morning', name: '早盘解读' },
      { id: 'indicator', name: '技术指标' },
      { id: 'pattern', name: '形态分析' },
      { id: 'strategy', name: '交易策略' },
      { id: 'advanced', name: '技术模型' },
    ])
  })
})
