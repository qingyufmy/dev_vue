import type { Pool } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { createStrategyCombinationWriter } from '../src/modules/strategies/infrastructure/mysql-strategy-combination-writer.js'

describe('strategy combination transaction', () => {
  it('rolls back both strategies when the second version insert fails', async () => {
    let insertCount = 0
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('FROM users')) return [[{ id: 7 }], []]
      if (sql.includes('FROM strategy_write_receipts_v4')) return [[], []]
      if (sql.includes('INSERT INTO strategies')) return [{ insertId: insertCount++ === 0 ? 101 : 102 }, []]
      if (sql.includes('SELECT COALESCE(MAX(version_number)')) return [[{ next_version: 1 }], []]
      if (sql.includes('INSERT INTO strategy_versions')) {
        if (insertCount === 2) throw new Error('injected second version failure')
        return [{ insertId: 201 }, []]
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
    const writer = createStrategyCombinationWriter({ getConnection: async () => connection } as unknown as Pool,
      () => ({ isAdmin: async () => false }))

    await expect(writer.create({ userId: 7, idempotencyKey: 'strategy-combo-test-0001', name: '黄金组合', description: '',
      analysisPromptText: '根据系统提供的真实行情证据分析趋势，证据不足时保持观望。', analysisConfig: {},
      traderPromptText: '根据分析结论与账户风险提出交易动作，条件不足时保持当前状态。', traderConfig: {} }))
      .rejects.toThrow('injected second version failure')
    expect(connection.beginTransaction).toHaveBeenCalledOnce()
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
  })
})
