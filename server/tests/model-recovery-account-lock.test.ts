import { describe, expect, it } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { createMysqlModelTaskRecovery } from '../src/modules/inference/composition.js'

describe('model recovery account lock port', () => {
  for (const scenario of ['trader', 'analysis', 'lock_failed'] as const) {
    it(`${scenario} preserves account-run-task lock order and rollback`, async () => {
      const calls: string[] = []
      let active = false, writes = 0
      const now = new Date('2026-09-10T00:00:00.000Z')
      const connection = {
        async beginTransaction() { active = true; calls.push('begin') },
        async commit() { active = false; calls.push('commit') },
        async rollback() { active = false; calls.push('rollback') }, release() { calls.push('release') },
        async execute(sql: string) {
          expect(active).toBe(true); expect(sql).not.toContain('trading_accounts')
          if (sql.startsWith('SELECT id FROM ai_')) { calls.push('run'); return [[{ id: 'run-1' }]] }
          if (sql.startsWith('SELECT id,status,deadline_at_utc')) {
            calls.push('task'); return [[{ id: 'task-1', status: 'running', deadline_at_utc: now }]]
          }
          if (/^(UPDATE|INSERT)/.test(sql)) { writes++; return [{ affectedRows: 1 }] }
          throw Error('unexpected SQL')
        },
      } as unknown as PoolConnection
      const pool = { async execute() { return [[{ id: 'task-1', purpose: scenario === 'analysis' ? 'analysis' : 'trader', trading_account_id: '5' }]] },
        async getConnection() { return connection } } as unknown as Pool
      const recovery = createMysqlModelTaskRecovery(pool, db => {
        expect(db).toBe(connection); expect(active).toBe(true)
        return { async lockAccount(id) {
          expect(id).toBe('5'); calls.push('account')
          if (scenario === 'lock_failed') throw Error('lock_failed')
        } }
      })
      if (scenario === 'lock_failed') {
        await expect(recovery.expireOverdue(now, 1)).rejects.toThrow('lock_failed')
        expect(calls).toEqual(['begin', 'account', 'rollback', 'release']); expect(writes).toBe(0)
      } else {
        expect(await recovery.expireOverdue(now, 1)).toBe(1)
        expect(calls).toEqual(['begin', ...(scenario === 'trader' ? ['account'] : []), 'run', 'task', 'commit', 'release'])
        expect(writes).toBe(4)
      }
      expect(active).toBe(false)
    })
  }
})
