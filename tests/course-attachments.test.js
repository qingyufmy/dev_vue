import { describe, expect, it } from 'vitest'
import {
  COURSE_ATTACHMENT_ACCEPT,
  COURSE_ATTACHMENT_MAX_BYTES,
  resolveCourseAttachmentPath,
  serializeCourseAttachment,
  validateCourseAttachmentFile,
} from '../server/course-attachments.js'

describe('course downloadable attachments', () => {
  it('accepts document attachments and rejects executable web content', () => {
    expect(COURSE_ATTACHMENT_ACCEPT).toContain('.pdf')
    expect(COURSE_ATTACHMENT_ACCEPT).toContain('.xlsx')
    expect(validateCourseAttachmentFile({
      originalname:'交易复盘模板.xlsx',
      mimetype:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer:Buffer.from('sheet'),
      size:5,
    })).toMatchObject({ ok:true, originalName:'交易复盘模板.xlsx', extension:'.xlsx', size:5 })
    expect(validateCourseAttachmentFile({
      originalname:'dangerous.html',
      mimetype:'text/html',
      buffer:Buffer.from('<script>'),
      size:8,
    })).toMatchObject({ ok:false })
    expect(validateCourseAttachmentFile({
      originalname:'oversized.pdf',
      mimetype:'application/pdf',
      buffer:Buffer.from('pdf'),
      size:COURSE_ATTACHMENT_MAX_BYTES + 1,
    })).toMatchObject({ ok:false, error:'单个附件不能超过 20 MB' })
  })

  it('serializes only a protected API download URL and validates the private URI', () => {
    const row = {
      id:9,
      episode_id:3,
      type:'attachment',
      title:'仓位计算表.xlsx',
      url:'course-attachment://ep3/1234_aabbcc.xlsx',
      structure:JSON.stringify({ original_name:'仓位计算表.xlsx', extension:'.xlsx', file_size:4096, uploaded_at:'2026-07-23T00:00:00.000Z' }),
      sort_order:2,
    }
    const attachment = serializeCourseAttachment(row)

    expect(attachment).toMatchObject({
      id:9,
      episode_id:3,
      file_name:'仓位计算表.xlsx',
      file_size:4096,
      download_url:'/api/course-items/3/attachments/9/download',
    })
    expect(attachment).not.toHaveProperty('url')
    expect(resolveCourseAttachmentPath(row)).toMatch(/course-attachments[\\/]ep3[\\/]1234_aabbcc\.xlsx$/)
    expect(resolveCourseAttachmentPath({ ...row, episode_id:4 })).toBeNull()
  })
})
