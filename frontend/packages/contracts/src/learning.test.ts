import { expect, it } from 'vitest'
import { learningDetailSchema, learningListSchema } from './learning'
const course = { id: '12', title: '课程', description: null, category: null, access_level: 'logged_in', updated_at: '2026-09-07T00:00:00.123Z', sort_order: 0 }
it('accepts UTC metadata and rejects ambiguous wall clocks', () => {
  expect(learningListSchema.safeParse({ items: [course], next_cursor: null }).success).toBe(true)
  expect(learningListSchema.safeParse({ items: [{ ...course, updated_at: '2026-09-07 00:00:00' }], next_cursor: null }).success).toBe(false)
})
it('rejects locked responses that contain a lesson or unsafe resource URL', () => {
  const lesson = { id: '1', title: '内容', duration_ms: '9007199254740993', progress: null, resources: [] }
  const detail = { course, access: 'allowed', lessons: [lesson], lessons_truncated: false }
  expect(learningDetailSchema.safeParse(detail).success).toBe(true)
  expect(learningDetailSchema.safeParse({ ...detail, access: 'login_required' }).success).toBe(false)
  expect(learningDetailSchema.safeParse({ ...detail, lessons: [{ ...lesson, resources: [{ kind: 'article_url', url: 'javascript:alert(1)' }] }] }).success).toBe(false)
})
