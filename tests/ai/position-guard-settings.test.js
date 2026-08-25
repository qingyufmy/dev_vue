import crypto from 'node:crypto'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POSITION_GUARD_CONFIG,
  DEFAULT_POSITION_GUARD_CONFIG_HASH,
  getPositionGuardGlobalControl,
  getPositionGuardProfile,
  getUserPositionGuardSetting,
  listEnabledPositionGuardAccounts,
  normalizePositionGuardConfig,
  positionGuardConfigHash,
  savePositionGuardGlobalControl,
  savePositionGuardProfile,
  saveUserPositionGuardSetting,
} from '../../server/routes/ai/position-guard.js'

function adminUser() {
  return { id: 7, role: 'admin', deletion_status: 'active', deleted_at: null }
}

function activeAccount() {
  return { id: 11, user_id: 3, is_deleted: 0, observe_status: 'active' }
}

function accountDb({ account = activeAccount(), setting = null } = {}) {
  const calls = []
  return {
    calls,
    async one(sql, params = []) {
      calls.push({ type: 'one', sql, params })
      if (sql.includes('FROM trading_accounts')) return account
      if (sql.includes('FROM user_position_guard_settings')) return setting
      return null
    },
    async execute(sql, params = []) {
      calls.push({ type: 'execute', sql, params })
      return { changes: 1, insertId: 1 }
    },
  }
}

describe('PivotGuard 设置与配置服务', () => {
  it('账号没有设置行时默认关闭', async () => {
    const result = await getUserPositionGuardSetting({ userId: 3, tradingAccountId: 11, db: accountDb() })
    expect(result).toMatchObject({ user_id: 3, trading_account_id: 11, enabled: false })
    expect(result).not.toHaveProperty('config_json')
  })

  it('拒绝读取其他用户或无效账号', async () => {
    const db = accountDb({ account: null })
    await expect(getUserPositionGuardSetting({ userId: 4, tradingAccountId: 11, db }))
      .rejects.toMatchObject({ code: 'position_guard_account_not_owned_or_inactive' })
  })

  it('账号开关默认隔离到本人账号，开启前要求至少一个有效参数版本', async () => {
    const missingProfile = accountDb()
    await expect(saveUserPositionGuardSetting({
      userId:3, tradingAccountId:11, enabled:true, db:missingProfile,
    })).rejects.toMatchObject({ code:'position_guard_profile_not_found' })

    const enabledDb = accountDb()
    const originalOne = enabledDb.one
    enabledDb.one = async (sql, params = []) => {
      if (sql.includes('FROM position_guard_profiles')) return { id:1 }
      return originalOne.call(enabledDb, sql, params)
    }
    const result = await saveUserPositionGuardSetting({
      userId:3, tradingAccountId:11, enabled:true, db:enabledDb,
      now:'2026-08-25 18:00:00',
    })
    expect(result).toMatchObject({ user_id:3, trading_account_id:11, enabled:true })
    expect(enabledDb.calls.some(call => call.type === 'execute'
      && call.sql.includes('INSERT INTO user_position_guard_settings'))).toBe(true)
  })

  it('普通 profile 响应不返回配置正文', async () => {
    const db = {
      async one() {
        return {
          id: 1, standard_symbol: 'XAUUSD', status: 'active', current_version_id: 2,
          version_id: 2, version_no: 1, config_hash: 'a'.repeat(64),
          config_json: JSON.stringify(DEFAULT_POSITION_GUARD_CONFIG),
        }
      },
    }
    const result = await getPositionGuardProfile({ standardSymbol: 'xauusd', db })
    expect(result).toMatchObject({ standard_symbol: 'XAUUSD', status: 'active', version_no: 1 })
    expect(result).not.toHaveProperty('config')
    expect(result).not.toHaveProperty('config_json')
  })

  it('拒绝无效配置及被移除的最大亏损/回撤字段', () => {
    expect(() => normalizePositionGuardConfig({})).toThrowError(/position_guard_config_missing:pivot_method/)
    expect(() => normalizePositionGuardConfig({
      ...DEFAULT_POSITION_GUARD_CONFIG,
      max_loss_money: 10,
    })).toThrowError(/position_guard_config_unknown/)
    expect(() => normalizePositionGuardConfig({
      ...DEFAULT_POSITION_GUARD_CONFIG,
      pivot_take_profit: { ...DEFAULT_POSITION_GUARD_CONFIG.pivot_take_profit, close_percent: 0 },
    })).toThrowError(/position_guard_config_invalid:pivot_take_profit\.close_percent/)
  })

  it('管理员保存配置时版本递增且旧版本正文不变', async () => {
    const profiles = []
    const versions = []
    const db = {
      async one(sql, params = []) {
        if (sql.includes('FROM users')) return adminUser()
        if (sql.includes('FROM position_guard_profiles')) {
          const profile = profiles.find(item => item.standard_symbol === params[0])
          if (!profile) return null
          return { ...profile }
        }
        if (sql.includes('FROM position_guard_profile_versions')) {
          const profileId = Number(params[0])
          const versionNo = params[1]
          const rows = versions.filter(item => item.profile_id === profileId)
          if (versionNo !== undefined) return rows.find(item => item.version_no === Number(versionNo)) || null
          return rows.sort((a, b) => b.version_no - a.version_no)[0] || null
        }
        return null
      },
      async execute(sql, params = []) {
        if (sql.includes('INSERT INTO position_guard_profiles')) {
          if (!profiles.length) profiles.push({ id: 1, standard_symbol: params[0], status: params[1] || 'active', current_version_id: null })
          return { changes: 1, insertId: 1 }
        }
        if (sql.includes('INSERT INTO position_guard_profile_versions')) {
          const row = {
            id: versions.length + 1,
            profile_id: Number(params[0]),
            version_no: Number(params[1]),
            config_json: params[2],
            config_hash: params[3],
            reason: params[4],
            created_by: params[5],
            created_at: params[6],
          }
          versions.push(row)
          return { changes: 1, insertId: row.id }
        }
        if (sql.includes('UPDATE position_guard_profiles')) {
          const profile = profiles[0]
          profile.current_version_id = Number(params[0])
          profile.status = params[1] || profile.status
          profile.changed_by = Number(params[2])
          profile.reason = params[3]
          profile.updated_at = params[4]
          return { changes: 1, insertId: 0 }
        }
        return { changes: 1, insertId: 0 }
      },
      async transaction(callback) { return callback(this) },
    }
    const first = await savePositionGuardProfile({
      adminUserId: 7, standardSymbol: 'XAUUSD', config: DEFAULT_POSITION_GUARD_CONFIG,
      status: 'active', reason: '首版默认', db, now: '2026-08-25 12:00:00',
    })
    const firstVersionJson = versions[0].config_json
    const changedConfig = normalizePositionGuardConfig({
      ...DEFAULT_POSITION_GUARD_CONFIG,
      break_stop: { ...DEFAULT_POSITION_GUARD_CONFIG.break_stop, distance_price: 11 },
    })
    const second = await savePositionGuardProfile({
      adminUserId: 7, standardSymbol: 'XAUUSD', config: changedConfig,
      reason: '调整突破距离', db, now: '2026-08-25 12:01:00',
    })
    expect(first.version_no).toBe(1)
    expect(second.version_no).toBe(2)
    expect(versions).toHaveLength(2)
    expect(versions[0].config_json).toBe(firstVersionJson)
    expect(versions[0].config_hash).toBe(positionGuardConfigHash(DEFAULT_POSITION_GUARD_CONFIG))
    expect(versions[1].config_hash).toBe(positionGuardConfigHash(changedConfig))
    expect(versions[0].config_json).not.toBe(versions[1].config_json)
  })

  it('平台总闸默认关闭，开启必须填写原因', async () => {
    const calls = []
    const db = {
      async one(sql) {
        calls.push(sql)
        if (sql.includes('FROM users')) return adminUser()
        return null
      },
      async execute(sql, params) {
        calls.push({ sql, params })
        return { changes: 1, insertId: 0 }
      },
    }
    expect((await getPositionGuardGlobalControl({ db })).enabled).toBe(false)
    await expect(savePositionGuardGlobalControl({ adminUserId: 7, enabled: true, db }))
      .rejects.toMatchObject({ code: 'position_guard_enable_reason_required' })
    const enabled = await savePositionGuardGlobalControl({
      adminUserId: 7, enabled: true, reason: '测试账号验证', db, now: '2026-08-25 12:00:00',
    })
    expect(enabled).toMatchObject({ enabled: true, changed_by: 7, reason: '测试账号验证' })
  })

  it('默认配置 JSON 与 hash 稳定', () => {
    const expectedJson = JSON.stringify({
      break_stop: { distance_price: 9, enabled: true, open_near_price: 10 },
      first_target_take_profit: {
        break_even_offset_price: 2, close_percent: 50, enabled: true,
        move_break_even: true, tolerance_price: 3,
      },
      pivot_cross_stop: { distance_price: 8, enabled: true, min_duration_seconds: 3 },
      pivot_method: 'fibonacci',
      pivot_take_profit: { close_percent: 50, enabled: true, move_break_even: true, tolerance_price: 3 },
      retrace_stop: { distance_price: 5, enabled: true },
    })
    const expectedHash = crypto.createHash('sha256').update(expectedJson).digest('hex')
    expect(positionGuardConfigHash(DEFAULT_POSITION_GUARD_CONFIG)).toBe(expectedHash)
    expect(DEFAULT_POSITION_GUARD_CONFIG_HASH).toBe(expectedHash)
    const migration = fs.readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    expect(migration).toContain("id: '200_pivot_guard_position_management'")
    expect(migration).toContain("VALUES ('XAUUSD', 'active'")
    expect(migration).toContain('break_even_pending TINYINT(1) NOT NULL DEFAULT 0')
    expect(migration).toContain('retry_after DATETIME DEFAULT NULL')
    expect(migration).toContain('last_completed_at DATETIME DEFAULT NULL')
  })

  it('enabled 账号查询包含当前归属过滤且不依赖配置 JSON', async () => {
    let query = ''
    const db = {
      async all(sql) {
        query = sql
        return [{
          user_id: 3, trading_account_id: 11, enabled_at: '2026-08-25 12:00:00',
          broker_server: 'Broker', login_account: '1001', broker_server_key: 'BROKER', ownership_history_id: 9,
        }]
      },
    }
    const rows = await listEnabledPositionGuardAccounts({ db })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: 3, trading_account_id: 11, ownership_history_id: 9 })
    expect(query).toContain('INNER JOIN mt5_account_bindings')
    expect(query).toContain('bindings.current_user_id = settings.user_id')
    expect(query).toContain('INNER JOIN mt5_account_ownership_history')
    expect(query).toContain('MAX(current_ownership.id)')
    expect(query).toContain('accounts.is_deleted = 0')
    expect(query).toContain("accounts.observe_status = 'active'")
    expect(rows[0]).not.toHaveProperty('config_json')
  })
})
