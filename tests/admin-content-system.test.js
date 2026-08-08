import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
}))
vi.mock('../server/utils.js', () => ({ fetchBilibiliVideo:vi.fn() }))

import { queryOne, queryRun, withTransaction } from '../server/db.js'
import { deleteAdminCourse, saveAdminCourse } from '../server/admin/content-system.js'

describe('统一后台课程服务', () => {
  beforeEach(() => vi.clearAllMocks())

  it('校验课程必填字段和枚举值', async () => {
    await expect(saveAdminCourse({ category:'morning', content_type:'video' })).rejects.toThrow('course_title_required')
    await expect(saveAdminCourse({ title:'课程', category:'unknown', content_type:'video' })).rejects.toThrow('invalid_course_category')
    await expect(saveAdminCourse({ title:'课程', category:'morning', content_type:'embed' })).rejects.toThrow('invalid_course_content_type')
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('创建课程后返回统一字段结构', async () => {
    queryOne
      .mockResolvedValueOnce({ max_id:7 })
      .mockResolvedValueOnce({ episode_id:8, number:8, title:'黄金早盘', category:'morning', content_type:'video', status:'draft' })
    queryRun.mockResolvedValueOnce({ insertId:8 })

    const course=await saveAdminCourse({ title:'黄金早盘', category:'morning', content_type:'video' })

    expect(course).toMatchObject({ id:8, episode_id:8, title:'黄金早盘', status:'draft' })
    expect(queryRun.mock.calls[0][0]).toContain('INSERT INTO courses')
    expect(queryRun.mock.calls[0][1]).toHaveLength(15)
  })

  it('删除课程时清理所有关联数据', async () => {
    queryOne.mockResolvedValueOnce({ episode_id:12, title:'待删除课程', category:'strategy', content_type:'article' })
    const run=vi.fn().mockResolvedValue([{ affectedRows:1 }])
    withTransaction.mockImplementation(callback=>callback(run))

    const deleted=await deleteAdminCourse(12)

    expect(deleted.id).toBe(12)
    expect(run).toHaveBeenCalledTimes(6)
    expect(run.mock.calls.at(-1)[0]).toContain('DELETE FROM courses')
  })
})
