import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
}))

import { queryOne, queryRun } from '../server/db.js'
import { calculatePlanExpiry, processReferralCommission, fetchBilibiliVideo, BILIBILI_HEADERS } from '../server/utils.js'

describe('calculatePlanExpiry', () => {
  it('lifetime 返回 2099-12-31', () => {
    expect(calculatePlanExpiry('lifetime')).toBe('2099-12-31 23:59:59')
  })

  it('year 从指定日期加一年', () => {
    const result = calculatePlanExpiry('year', '2026-01-15 10:00:00')
    expect(result).toMatch(/^2027-01-1[45] \d{2}:00:00$/)
  })

  it('month 从指定日期加一月', () => {
    const result = calculatePlanExpiry('month', '2026-01-15 10:00:00')
    expect(result).toMatch(/^2026-02-1[45] \d{2}:00:00$/)
  })

  it('month 跨年', () => {
    const result = calculatePlanExpiry('month', '2026-12-15 10:00:00')
    expect(result).toMatch(/^2027-01-1[45] \d{2}:00:00$/)
  })

  it('无 fromDate 使用当前时间', () => {
    const result = calculatePlanExpiry('month')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('processReferralCommission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('amount <= 0 时跳过', async () => {
    await processReferralCommission(1, 0, 'plus', 'Plus 月付', 'monthly')
    expect(queryOne).not.toHaveBeenCalled()
  })

  it('无推荐记录时跳过', async () => {
    queryOne.mockResolvedValueOnce(null)
    await processReferralCommission(1, 100, 'plus', 'Plus 月付', 'monthly')
    expect(queryOne).toHaveBeenCalledTimes(1)
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('有推荐记录时计算返佣', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 1, referrer_id: 2 })
      .mockResolvedValueOnce({ rate_bps: 1000 })
    queryRun.mockResolvedValue({ changes: 1 })

    await processReferralCommission(1, 100, 'plus', 'Plus 月付', 'monthly')

    expect(queryRun).toHaveBeenCalledTimes(2)
    const updateCall = queryRun.mock.calls[0]
    expect(updateCall[0]).toContain('UPDATE referrals')
    expect(updateCall[1]).toContain(100) // amount_cents
    expect(updateCall[1]).toContain(10) // commission = 100 * 1000 / 10000
  })

  it('无规则时使用默认 1000 bps', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 1, referrer_id: 2 })
      .mockResolvedValueOnce(null)
    queryRun.mockResolvedValue({ changes: 1 })

    await processReferralCommission(1, 50, 'plus', 'Plus', 'monthly')

    const updateCall = queryRun.mock.calls[0]
    expect(updateCall[1]).toContain(5) // 50 * 1000 / 10000
  })
})

describe('fetchBilibiliVideo', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('成功获取视频信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        code: 0,
        data: { pic: 'http://example.com/cover.jpg', duration: 120, title: '测试视频', cid: 12345 }
      })
    }))

    const result = await fetchBilibiliVideo('BV1xx411c7mD')
    expect(result).toEqual({
      cover: 'https://example.com/cover.jpg',
      duration: 120,
      title: '测试视频',
      cid: 12345,
    })
  })

  it('API 返回错误时返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ code: -400, data: null })
    }))

    const result = await fetchBilibiliVideo('invalid')
    expect(result).toBeNull()
  })

  it('网络异常时抛出错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    await expect(fetchBilibiliVideo('BV1xx')).rejects.toThrow('network error')
  })
})

describe('BILIBILI_HEADERS', () => {
  it('包含必要的请求头', () => {
    expect(BILIBILI_HEADERS['User-Agent']).toBeTruthy()
    expect(BILIBILI_HEADERS['Referer']).toContain('bilibili.com')
  })
})
