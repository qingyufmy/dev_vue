import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
  beijingNow:vi.fn(()=>'2026-07-23 14:10:00'),
}))

import { queryOne, withTransaction } from '../server/db.js'
import { getAdminPlatformRiskPolicy, saveAdminPlatformRiskPolicy } from '../server/admin/risk-audit.js'

describe('统一后台平台风控规则', () => {
  beforeEach(() => vi.clearAllMocks())

  it('没有历史版本时返回完整默认规则和单位元数据', async () => {
    queryOne.mockResolvedValueOnce(null)
    const policy=await getAdminPlatformRiskPolicy()
    expect(policy.version).toBeNull()
    expect(policy.values.max_position_size).toBe(0.05)
    expect(policy.rule_metadata.max_position_size.unit_label).toBe('手')
    expect(policy.controls.max_position_size.allowed_max).toBe(0.05)
  })

  it('保存时创建立即生效的新版本并应用平台边界', async () => {
    queryOne.mockResolvedValueOnce({ id:4, active_version_id:6 })
    const run=vi.fn()
      .mockResolvedValueOnce([[{ id:6, version_no:2, config_json:'{}' }],[]])
      .mockResolvedValueOnce([{ insertId:77 }])
      .mockResolvedValueOnce([{ affectedRows:1 }])
    withTransaction.mockImplementation(callback=>callback(run))

    const result=await saveAdminPlatformRiskPolicy({actorId:1,values:{max_position_size:1},controls:{max_position_size:{allowed_max:5}},reason:'测试新边界'})

    expect(result).toEqual({active_version_id:77,version_no:3,effective_at:'2026-07-23 14:10:00'})
    const stored=JSON.parse(run.mock.calls[1][1][2])
    expect(stored.values.max_position_size).toBe(1)
    expect(stored.controls.max_position_size.allowed_max).toBe(5)
    expect(run.mock.calls[2][1][0]).toBe(77)
  })
})
