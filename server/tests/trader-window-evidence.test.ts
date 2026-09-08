import { createSubscriptionPreferencesReader } from '../src/modules/strategies/composition.js'
const traderWindowStaleReason = (clock: Parameters<typeof staleReason>[0], connection: Parameters<typeof staleReason>[1], run: TraderRun) => staleReason(clock, connection, run, createSubscriptionPreferencesReader)
import { createTransactionAccountClock } from '../src/modules/trading/composition.js'
import { describe, expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { contentHash, type TraderRun } from '../src/modules/inference/index.js'
import { subscriptionWindowFingerprint } from '../src/modules/strategies/index.js'
import { traderWindowStaleReason as staleReason } from '../src/modules/inference/infrastructure/mysql-trader-window-evidence.js'

describe('frozen trader window evidence', () => {
  it('hashes parsed configuration independent of JSON key order and whitespace', () => {
    const config = { version: 1, timezone: 'terminal_server', enabled: false, weekdays: [1], windows: [{ start: '22:00', end: '02:00' }], outsideBehavior: 'pause_all' }
    const reordered = Object.fromEntries(Object.entries(config).reverse())
    expect(subscriptionWindowFingerprint(config, 'terminal_server')).toBe(subscriptionWindowFingerprint(JSON.stringify(reordered, null, 2), 'terminal_server'))
    expect(subscriptionWindowFingerprint(config, 'terminal_server')).not.toBe(subscriptionWindowFingerprint({ ...config, outsideBehavior: 'signals_only' }, 'terminal_server'))
  })
  it('does not manufacture evidence for old snapshots or accept tampered payload', async () => {
    for (const snapshot of [{ kind: 'trader' }, { subscriptionWindowHash: 'bad' }]) {
      const connection = { async execute() { return [[{ payload_json: snapshot, payload_sha256: contentHash(snapshot) }]] } } as unknown as PoolConnection
      expect(await traderWindowStaleReason(createTransactionAccountClock(connection), connection, { inputSnapshotId: 's', userId: 42, tradingAccountId: '7' } as TraderRun)).toBe('trader_schedule_unproven')
    }
    const connection = { async execute() { return [[{ payload_json: { subscriptionWindowHash: 'a'.repeat(64) }, payload_sha256: 'b'.repeat(64) }]] } } as unknown as PoolConnection
    expect(await traderWindowStaleReason(createTransactionAccountClock(connection), connection, {} as TraderRun)).toBe('trader_schedule_unproven')
  })
  it('compares durable snapshot hash with current configuration, ignoring operational cursor revision', async () => {
    const fingerprint = subscriptionWindowFingerprint({ enabled: false }, 'UTC')
    const snapshot = { subscriptionWindowHash: fingerprint, executionPreferences: { contractVersion: 1, takeProfitMode: 'ai_recommended', revision: '1' } }
    let timezone = 'UTC', cursorRevision = 1
    const connection = { async execute(sql: string) {
      if (sql.includes('FROM subscription_execution_preferences_v4')) return [[{ contract_version: 1, take_profit_mode: 'ai_recommended', revision: '1' }]]
      if (sql.includes('FROM inference_snapshots')) return [[{ payload_json: JSON.stringify(snapshot), payload_sha256: contentHash(snapshot) }]]
      return [[{ receive_timezone: timezone, receive_window_json: { enabled: false }, revision: cursorRevision }]]
    } } as unknown as PoolConnection
    const run = { inputSnapshotId: 's', subscriptionId: 'sub', userId: 42, tradingAccountId: '7', subscriptionRevision: 1, strategyId: '20', strategyVersionId: '21' } as TraderRun
    expect(await traderWindowStaleReason(createTransactionAccountClock(connection), connection, run)).toBeNull()
    cursorRevision = 99
    expect(await traderWindowStaleReason(createTransactionAccountClock(connection), connection, run)).toBeNull()
    timezone = 'terminal_server'
    expect(await traderWindowStaleReason(createTransactionAccountClock(connection), connection, run)).toBe('trader_schedule_changed')
  })
})
