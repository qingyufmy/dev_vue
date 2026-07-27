import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
  beijingNow:vi.fn(() => '2026-07-23 14:10:00'),
}))

import { queryAll, queryOne } from '../server/db.js'
import { getAdminRiskAuditOverview, listAdminAuditEvents } from '../server/admin/risk-audit.js'

describe('admin risk overview account pagination', () => {
  beforeEach(() => vi.clearAllMocks())

  it('paginates trading accounts in SQL and returns independent account metadata', async () => {
    queryOne.mockImplementation(async sql => {
      if (sql.includes('AS decisions_today')) return { decisions_today:4, rejected_today:1, adjusted_today:1, paused_accounts:2, trading_accounts:19, admin_actions_today:3 }
      if (sql.includes('FROM global_risk_control')) return { global_kill_switch:0, reason:'', changed_by:null, updated_at:null }
      if (sql.includes('FROM trading_accounts WHERE is_deleted = 0')) return { total:19 }
      if (sql.includes('FROM risk_decisions decisions')) return { total:0 }
      return null
    })
    queryAll.mockImplementation(async sql => {
      if (sql.includes('FROM trading_accounts accounts')) return [{ id:17, user_id:9, login_account:'596520', nickname:'主账户', broker_server:'Broker-Demo', halt_status:'active', user_kill_switch:0, data_complete:1 }]
      return []
    })

    const result = await getAdminRiskAuditOverview({ accountPage:3, accountPageSize:8 })
    const accountQuery = queryAll.mock.calls.find(([sql]) => sql.includes('FROM trading_accounts accounts'))

    expect(accountQuery[0]).toContain('LIMIT ? OFFSET ?')
    expect(accountQuery[0]).not.toContain('LIMIT 500')
    expect(accountQuery[0]).toContain('accounts.observe_status')
    expect(accountQuery[0]).toContain("'transferred'")
    expect(accountQuery[1]).toEqual([8,16])
    expect(queryAll.mock.calls.some(([sql]) => sql.includes('FROM risk_decisions decisions'))).toBe(false)
    expect(result.accounts[0]).toMatchObject({ id:17, user_id:9, user_kill_switch:false, data_complete:true })
    expect(result.account_pagination).toEqual({ page:3, page_size:8, total:19, total_pages:3 })
  })

  it('filters the immutable audit ledger by target and returns complete summary metrics', async () => {
    queryOne.mockResolvedValue({ total:2, today:1, actors:1, target_types:1 })
    queryAll.mockResolvedValue([{ id:41, user_id:1, action:'system_config_update', target_type:'system_config', target_id:7, detail:{ category:'mail' } }])

    const result = await listAdminAuditEvents({ page:1, pageSize:20, search:'邮箱', targetType:'system_config' })
    const summaryQuery = queryOne.mock.calls[0]
    const eventQuery = queryAll.mock.calls[0]

    expect(summaryQuery[0]).toContain('logs.target_type = ?')
    expect(summaryQuery[1]).toEqual(['%邮箱%','%邮箱%','%邮箱%','%邮箱%','system_config'])
    expect(eventQuery[1]).toEqual(['%邮箱%','%邮箱%','%邮箱%','%邮箱%','system_config',20,0])
    expect(result.summary).toEqual({ total:2, today:1, actors:1, target_types:1 })
    expect(result.events[0]).toMatchObject({ id:41, user_id:1, target_type:'system_config' })
  })
})
