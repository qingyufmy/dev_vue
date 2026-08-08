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
    expect(result).toBe('2027-01-15 10:00:00')
  })

  it('month 从指定日期加一月', () => {
    const result = calculatePlanExpiry('month', '2026-01-15 10:00:00')
    expect(result).toBe('2026-02-15 10:00:00')
  })

  it('month 跨年', () => {
    const result = calculatePlanExpiry('month', '2026-12-15 10:00:00')
    expect(result).toBe('2027-01-15 10:00:00')
  })

  it('无 fromDate 使用当前时间', () => {
    const result = calculatePlanExpiry('month')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('preserves Beijing wall-clock time for an explicitly zoned renewal date', () => {
    expect(calculatePlanExpiry('month', new Date('2026-08-24T23:59:59+08:00')))
      .toBe('2026-09-24 23:59:59')
  })

  it('clamps month-end and leap-day renewals to the target calendar month', () => {
    expect(calculatePlanExpiry('month', '2026-01-31 23:59:59')).toBe('2026-02-28 23:59:59')
    expect(calculatePlanExpiry('year', '2024-02-29 23:59:59')).toBe('2025-02-28 23:59:59')
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
    await processReferralCommission(1, 100, 'plus', 'Plus 月付', 'monthly', 'order-1')
    expect(queryOne).toHaveBeenCalledTimes(1)
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('有推荐记录时计算返佣', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 1, referrer_id: 2, order_id:null })
      .mockResolvedValueOnce({ rate_bps: 1000 })
    queryRun.mockResolvedValue({ changes: 1 })

    await processReferralCommission(1, 100, 'plus', 'Plus 月付', 'monthly', 'order-1')

    expect(queryRun).toHaveBeenCalledTimes(2)
    const updateCall = queryRun.mock.calls[0]
    expect(updateCall[0]).toContain('UPDATE referrals')
    expect(updateCall[1]).toContain(100) // amount_cents
    expect(updateCall[1]).toContain(10) // commission = 100 * 1000 / 10000
  })

  it('将订单 month 周期映射到后台 monthly 规则并兼容 MySQL DECIMAL 字符串', async () => {
    queryOne
      .mockResolvedValueOnce({ id:1, referrer_id:2, order_id:null })
      .mockResolvedValueOnce({ rate_bps:'500' })
    queryRun.mockResolvedValue({ changes:1 })

    await processReferralCommission(1, '100.00', 'plus', 'Plus 月付', 'month', 'order-2')

    expect(queryOne).toHaveBeenNthCalledWith(2,
      expect.stringContaining('referral_rules'), ['plus', 'monthly'])
    expect(queryRun.mock.calls[0][1]).toContain(5)
    expect(queryRun.mock.calls[1][1][3]).toContain('$100.00')
  })

  it('无规则时使用默认 1000 bps', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 1, referrer_id: 2, order_id:null })
      .mockResolvedValueOnce(null)
    queryRun.mockResolvedValue({ changes: 1 })

    await processReferralCommission(1, 50, 'plus', 'Plus', 'monthly', 'order-3')

    const updateCall = queryRun.mock.calls[0]
    expect(updateCall[1]).toContain(5) // 50 * 1000 / 10000
  })

  it('does not overwrite a referral already attributed to the same order', async () => {
    queryOne.mockResolvedValueOnce({ id:1, referrer_id:2, order_id:'order-4' })
    await expect(processReferralCommission(1, 50, 'plus', 'Plus', 'monthly', 'order-4'))
      .resolves.toEqual({ status:'already_recorded' })
    expect(queryOne).toHaveBeenCalledTimes(1)
    expect(queryRun).not.toHaveBeenCalled()
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
