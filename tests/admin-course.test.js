import { describe, expect, it } from 'vitest'
import { getCourseMediaValidationError } from '../public/src/lib/admin-course.js'

describe('admin course media validation', () => {
  it('allows a new article without video media', () => {
    expect(getCourseMediaValidationError({
      contentType: 'article',
      isExistingCourse: false,
      hasVideoFile: false,
      bilibiliId: '',
    })).toBe('')
  })

  it('requires media when creating a video course', () => {
    expect(getCourseMediaValidationError({
      contentType: 'video',
      isExistingCourse: false,
      hasVideoFile: false,
      bilibiliId: '',
    })).toBe('请上传新视频或填写B站BV号')
  })

  it('allows an existing video course and new video media inputs', () => {
    expect(getCourseMediaValidationError({ contentType: 'video', isExistingCourse: true })).toBe('')
    expect(getCourseMediaValidationError({ contentType: 'video', hasVideoFile: true })).toBe('')
    expect(getCourseMediaValidationError({ contentType: 'video', bilibiliId: 'BV123' })).toBe('')
  })
})
