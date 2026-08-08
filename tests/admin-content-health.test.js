import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryAll:vi.fn(),
  queryOne:vi.fn(),
  queryRun:vi.fn(),
  withTransaction:vi.fn(),
}))
vi.mock('../server/utils.js', () => ({ fetchBilibiliVideo:vi.fn() }))
vi.mock('../server/course-attachments.js', () => ({ deleteCourseAttachmentDirectory:vi.fn() }))

import { getAdminContentSystemOverview } from '../server/admin/content-system.js'
import { queryAll, queryOne } from '../server/db.js'

describe('administrator content health overview', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns one aggregate completeness model without per-course queries', async () => {
    queryOne
      .mockResolvedValueOnce({ courses_total:7, courses_published:4, feedback_total:2 })
      .mockResolvedValueOnce({ published_total:4, complete_count:1, missing_description:1,
        missing_video:1, missing_attachment:2, missing_quiz:2, missing_visual:3,
        stale_30d:1, incomplete_with_learning:2 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    const result = await getAdminContentSystemOverview()

    expect(result.content_health).toMatchObject({
      published_total:4,
      complete_count:1,
      completeness_percent:25,
      incomplete_with_learning:2,
      feedback_workflow_available:false,
    })
    const completenessSql = queryOne.mock.calls[1][0]
    expect(completenessSql).toContain('LEFT JOIN (')
    expect(completenessSql).toContain('GROUP BY episode_id')
    expect(queryOne).toHaveBeenCalledTimes(2)
  })

  it('uses null rather than a misleading 100 percent when no course is published', async () => {
    queryOne.mockResolvedValueOnce({}).mockResolvedValueOnce({ published_total:0, complete_count:0 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    expect((await getAdminContentSystemOverview()).content_health.completeness_percent).toBeNull()
  })
})
