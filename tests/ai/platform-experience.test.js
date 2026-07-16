import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-16 12:00:00'),
}))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/routes/ai/memory-system.js', () => ({
  sanitizeMemoryText: (value, max = 4000) => String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max),
}))
vi.mock('../../server/routes/ai/inference-snapshots.js', () => ({ sha256: value => `hash:${value}` }))

import { createPlatformExperienceCandidateFromApprovedReview, retrievePlatformExperience,
  sanitizePlatformExperienceText } from '../../server/routes/ai/platform-experience.js'

describe('platform strategy experience boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes account, position and lot-specific lessons while preserving market lessons', () => {
    const value = sanitizePlatformExperienceText('H1 突破后等待回踩确认。账户余额不足，应减少手数。震荡区间不要追价。')
    expect(value).toContain('H1 突破后等待回踩确认')
    expect(value).toContain('震荡区间不要追价')
    expect(value).not.toContain('账户余额')
    expect(value).not.toContain('手数')
  })

  it('creates a candidate only for an approved platform-strategy review', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: 7, status: 'approved', approved_version_id: 9,
        evidence_json: JSON.stringify({ inference_time:{ snapshot:{ strategy_id:3 }, signal:{ timeframe:'H1', signal_type:'buy' } }, post_trade:{ outcome:{ symbol:'XAUUSD' } } }) })
      .mockResolvedValueOnce({ id: 9, content_json: JSON.stringify({ lessons:['等待 H1 回踩确认'], strengths:[] }) })
      .mockResolvedValueOnce({ id: 3 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 11, status: 'candidate' })
    db.queryRun.mockResolvedValue({ insertId: 11, changes: 1 })
    await expect(createPlatformExperienceCandidateFromApprovedReview(7, 1)).resolves.toMatchObject({ id: 11, status:'candidate' })
    expect(db.queryRun.mock.calls[0][0]).toContain('platform_strategy_experience_items')
  })

  it('shadow mode records selections but never injects them', async () => {
    db.queryOne.mockResolvedValue({ mode:'shadow', max_items:5, runtime_token_budget:800, policy_version:2 })
    db.queryAll.mockResolvedValue([{ id:4, lesson_text:'等待确认', platform_version:1 }])
    db.queryRun.mockResolvedValue({ changes:1 })
    const result = await retrievePlatformExperience({ strategyId:3, symbol:'XAUUSD', timeframe:'H1' })
    expect(result.mode).toBe('shadow')
    expect(result.promptBlock).toBe('')
    expect(result.selectedItemIds).toEqual([4])
  })

  it('keeps platform experience separate from personal memory in runtime code', () => {
    const llm = readFileSync(new URL('../../server/routes/ai/llm.js', import.meta.url), 'utf8')
    const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
    const migration = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    expect(llm).toContain("config._market_only && typeof config._platformExperienceContext === 'string'")
    expect(scheduler).toContain('retrievePlatformExperience')
    expect(migration).toContain('077_platform_strategy_experience')
    expect(migration).toContain("ss.memory_mode = 'platform_only'")
  })
})
