import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createMysqlInferenceRepository } from '../src/modules/inference/composition.js'
import type { InferenceRepository } from '../src/modules/inference/index.js'
import { contentHash } from '../src/modules/inference/index.js'

describe('inference input transaction boundary', () => {
  for (const method of ['beginAnalysis', 'beginTrader'] as const) {
    const input = () => {
      const snapshot = { kind: method === 'beginAnalysis' ? 'analysis' : 'trader', market: { symbol: 'XAUUSD' } }
      return { userId: 7, runId: 'original-run', snapshot, snapshotHash: contentHash(snapshot) } as unknown as Parameters<InferenceRepository[typeof method]>[0]
    }
    it(`${method} rejects a changed input without memory before acquiring a connection`, async () => {
      const getConnection = vi.fn()
      const unused = () => { throw Error('unexpected dependency') }
      const repository = createMysqlInferenceRepository({ getConnection } as unknown as Pool, unused, unused, unused, { subscribers: unused, inventory: unused, risks: unused })
      const value = input()
      value.snapshotHash = '0'.repeat(64)
      await expect(repository[method](value as never)).rejects.toMatchObject({ code: 'inference_snapshot_hash_mismatch' })
      expect(getConnection).not.toHaveBeenCalled()
    })
    it(`${method} captures run and user before waiting for the connection`, async () => {
      const value = input(), calls: unknown[][] = []
      const connection = {
        async beginTransaction() {}, async rollback() {}, release() {},
        async execute(_sql: string, args: unknown[]) { calls.push(args); return [[]] },
      }
      const unused = () => { throw Error('unexpected dependency') }
      const repository = createMysqlInferenceRepository({ async getConnection() {
        value.runId = 'changed-run'; value.userId = 8
        return connection
      } } as unknown as Pool, unused, unused, unused, { subscribers: unused, inventory: unused, risks: unused })
      await expect(repository[method](value as never)).rejects.toMatchObject({ code: method === 'beginAnalysis' ? 'analysis_not_found' : 'trader_run_not_found' })
      expect(calls).toEqual([['original-run', 7]])
    })
  }
})

it.each([
  [{ source_account_id: '20' }, 'analysis_market_source_mismatch'],
  [{ source_account_id: '20', source_mode: 'public', source_generation: 3, source_connection_id: 'selected-connection' }, 'passed_source_validation'],
  [{ source_account_id: '20', source_mode: 'public' }, 'analysis_market_source_mismatch'],
])('distinguishes selected public source from a legacy account mismatch', async (market, expected) => {
  const connection = { async beginTransaction() {}, async rollback() {}, release() {}, async execute(sql: string) {
    if (sql.startsWith('SELECT r.id')) return [[{ id: 'run', user_id: 1, strategy_id: '1', strategy_version_id: '7', market_source_account_id: '7', revision: 1, status: 'queued', standard_symbol: 'XAUUSD' }]]
    throw Error('passed_source_validation')
  } }
  const unused = () => { throw Error('unused') }
  const repo = createMysqlInferenceRepository({ getConnection: async () => connection } as unknown as Pool, unused, unused, unused, { subscribers: unused, inventory: unused, risks: unused })
  const snapshot = { kind: 'analysis', strategy: { id: '1', versionId: '7' }, market, capturedAt: '2026-09-14T08:35:00.000Z' }
  await expect(repo.beginAnalysis({ runId: 'run', userId: 1, expectedRevision: 1, snapshot, snapshotHash: contentHash(snapshot) } as unknown as Parameters<InferenceRepository['beginAnalysis']>[0])).rejects.toThrow(expected)
})
