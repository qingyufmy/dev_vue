import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(), queryAll: vi.fn(), queryRun: vi.fn(),
  withTransaction: vi.fn(async fn => fn(vi.fn())),
}))

vi.mock('../../server/db.js', () => ({
  ...mocks,
  beijingNow: () => '2026-07-15 23:00:00',
}))

import { assertAiGovernanceSchemaReady, getEffectiveFeatureFlags, updateAiFeatureFlags,
  updateRiskRuleRollout } from '../../server/routes/ai/rollout-governance.js'

describe('AI rollout governance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryRun.mockResolvedValue({ changes: 1, insertId: 1 })
  })

  it('combines global and user flags without allowing a user to bypass a global off switch', async () => {
    mocks.queryOne
      .mockResolvedValueOnce({ review_generation_enabled: 0, experience_memory_enabled: 1, retrieval_shadow_enabled: 1 })
      .mockResolvedValueOnce({ review_generation_enabled: 1, experience_memory_enabled: 0, retrieval_shadow_enabled: null })
    const flags = await getEffectiveFeatureFlags(7)
    expect(flags.review_generation_enabled).toBe(false)
    expect(flags.experience_memory_enabled).toBe(false)
    expect(flags.retrieval_shadow_enabled).toBe(true)
  })

  it('rejects non-admin global flag changes', async () => {
    await expect(updateAiFeatureFlags({ actorId:7, actorRole:'user', flags:{ review_generation_enabled:true } }))
      .rejects.toThrow('admin_required')
    expect(mocks.queryRun).not.toHaveBeenCalled()
  })

  it('never permits a mandatory rule to enter shadow mode', async () => {
    await expect(updateRiskRuleRollout({ actorId:1, actorRole:'admin', ruleCode:'kill_switch', mode:'shadow' }))
      .rejects.toThrow('forced_rule_must_enforce')
    expect(mocks.queryRun).not.toHaveBeenCalled()
  })

  it('fails readiness when any required migration is absent', async () => {
    mocks.queryAll.mockResolvedValue([])
    await expect(assertAiGovernanceSchemaReady()).rejects.toThrow('ai_schema_migrations_missing')
    expect(mocks.queryOne).not.toHaveBeenCalled()
  })
})
