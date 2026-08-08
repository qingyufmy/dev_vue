import { describe, expect, it } from 'vitest'
import { getCoursePage, getCoursesForCategory } from '../public/src/lib/course-catalog.js'
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
      { id: 'advanced', name: '经济指标' },
    ])
  })

  it('defaults to nine courses per stream batch and exposes continuation state', () => {
    const streamCourses = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      category: 'morning',
      createdAt: `2026-08-${String(index + 1).padStart(2, '0')}`,
    }))

    const first = getCoursePage(streamCourses, 'morning')
    expect(first.items).toHaveLength(9)
    expect(first.items[0].id).toBe(12)
    expect(first).toMatchObject({ total: 12, nextOffset: 9, hasMore: true })

    const second = getCoursePage(streamCourses, 'morning', first.nextOffset)
    expect(second.items.map(course => course.id)).toEqual([3, 2, 1])
    expect(second).toMatchObject({ total: 12, nextOffset: 12, hasMore: false })
  })
})
