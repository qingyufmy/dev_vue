import { describe, expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { assertDistributionWindow, assertRiskDecisionWindow } from '../src/modules/execution/infrastructure/mysql-execution-window.js'
import { subscriptionWindowFingerprint } from '../src/modules/strategies/index.js'
import { sha256Canonical } from '../src/modules/execution/domain/execution.js'

const evidence = (window: unknown, timezone: string) => {
  const snapshot = { subscriptionWindowHash: subscriptionWindowFingerprint(window, timezone), executionPreferences: { contractVersion: 1, takeProfitMode: 'ai_recommended', revision: '1' } }
  return { preference_version: 1, preference_mode: 'ai_recommended', preference_revision: '1', snapshot_json: JSON.stringify(snapshot), snapshot_sha256: sha256Canonical(snapshot) }
}
const distributionEvidence = (timezone = 'UTC') => {
  const frozenContext = { subscription: { windowHash: subscriptionWindowFingerprint({ enabled: false }, timezone) } }
  return { frozen_context_json: frozenContext, command_json: {}, distribution_id: 'distribution', source_outcome_id: null, source_ticket: null,
    request_sha256: sha256Canonical({ distributionId: 'distribution', targetId: 'target', command: {}, frozenContext, sourceOutcomeId: null, sourceTicket: null }) }
}

describe('execution subscription window', () => {
  it('refuses changed preference content, changed revision, and missing current settings', async () => {
    const base = { receive_timezone: 'UTC', receive_window_json: { enabled: false }, ...evidence({ enabled: false }, 'UTC') }
    for (const changes of [{ preference_mode: 'trend' }, { preference_revision: '2' }, { preference_version: null }, { preference_revision: null }]) {
      const db = { execute: async () => [[{ ...base, ...changes }]] } as unknown as PoolConnection
      await expect(assertRiskDecisionWindow(db, 'risk', 42, '7', new Date())).rejects.toThrow('execution_preferences_changed')
    }
    const old = { subscriptionWindowHash: subscriptionWindowFingerprint({ enabled: false }, 'UTC') }
    const db = { execute: async () => [[{ ...base, snapshot_json: old, snapshot_sha256: sha256Canonical(old) }]] } as unknown as PoolConnection
    await expect(assertRiskDecisionWindow(db, 'risk', 42, '7', new Date())).rejects.toThrow('execution_preferences_changed')
  })
  it('binds manual-order distribution to its frozen target and refuses a missing subscription', async () => {
    let present = false
    const connection = { async execute(_sql: string, args: unknown[]) {
      expect(args).toEqual(['target', 42, '7'])
      return [present ? [{ receive_timezone: 'UTC', receive_window_json: { enabled: false }, ...distributionEvidence() }] : []]
    } } as unknown as PoolConnection
    await expect(assertDistributionWindow(connection, 'target', 42, '7', new Date())).rejects.toThrow('execution_subscription_changed')
    present = true
    await expect(assertDistributionWindow(connection, 'target', 42, '7', new Date())).resolves.toBeUndefined()
  })
  it('rejects old, tampered or changed distribution window evidence', async () => {
    const base = { receive_timezone: 'UTC', receive_window_json: { enabled: false } }
    let row: object = base
    const connection = { async execute() { return [[row]] } } as unknown as PoolConnection
    await expect(assertDistributionWindow(connection, 'target', 42, '7', new Date())).rejects.toThrow('execution_schedule_unproven')
    row = { ...base, ...distributionEvidence(), request_sha256: 'a'.repeat(64) }
    await expect(assertDistributionWindow(connection, 'target', 42, '7', new Date())).rejects.toThrow('execution_schedule_unproven')
    row = { ...base, ...distributionEvidence('terminal_server') }
    await expect(assertDistributionWindow(connection, 'target', 42, '7', new Date())).rejects.toThrow('execution_schedule_changed')
  })
  it('refuses missing/changed subscription and malformed window, preserves disabled window', async () => {
    let rows: unknown[] = []
    const connection = { async execute(_sql: string, args: unknown[]) {
      expect(args).toEqual(['risk', 42, '7']); return [rows]
    } } as unknown as PoolConnection
    await expect(assertRiskDecisionWindow(connection, 'risk', 42, '7', new Date())).rejects.toThrow('execution_subscription_changed')
    rows = [{ receive_timezone: 'UTC', receive_window_json: {} }]
    await expect(assertRiskDecisionWindow(connection, 'risk', 42, '7', new Date())).rejects.toThrow('execution_schedule_invalid')
    rows = [{ receive_timezone: 'UTC', receive_window_json: { enabled: false }, ...evidence({ enabled: false }, 'UTC') }]
    await expect(assertRiskDecisionWindow(connection, 'risk', 42, '7', new Date())).resolves.toBeUndefined()
  })
  it('rechecks terminal clock and exclusive boundary even for signals-only', async () => {
    let queries = 0
    const window = { version: 1, timezone: 'terminal_server', enabled: true, weekdays: [1], windows: [{ start: '22:00', end: '02:00' }], outsideBehavior: 'signals_only' }
    const connection = { async execute(sql: string) {
      queries += 1
      if (sql.includes('FROM risk_decisions_v4')) return [[{ receive_timezone: 'terminal_server', receive_window_json: window, ...evidence(window, 'terminal_server') }]]
      return [[{ timezone_offset_minutes: 180, clock_status: 'calibrated' }]]
    } } as unknown as PoolConnection
    await expect(assertRiskDecisionWindow(connection, 'risk', 42, '7', new Date('2026-09-07T19:00:00Z'))).resolves.toBeUndefined()
    await expect(assertRiskDecisionWindow(connection, 'risk', 42, '7', new Date('2026-09-07T23:00:00Z'))).rejects.toThrow('execution_schedule_closed')
    expect(queries).toBe(4)
  })
  it('refuses missing, tampered, or superseded evidence even when the current window allows execution', async () => {
    const base = { receive_timezone: 'UTC', receive_window_json: { enabled: false } }
    let row: object = base
    const connection = { async execute() { return [[row]] } } as unknown as PoolConnection
    await expect(assertRiskDecisionWindow(connection, 'risk', 42, '7', new Date())).rejects.toThrow('execution_schedule_unproven')
    row = { ...base, ...evidence({ enabled: false }, 'UTC'), snapshot_sha256: 'a'.repeat(64) }
    await expect(assertRiskDecisionWindow(connection, 'risk', 42, '7', new Date())).rejects.toThrow('execution_schedule_unproven')
    row = { ...base, ...evidence({ enabled: false }, 'terminal_server') }
    await expect(assertRiskDecisionWindow(connection, 'risk', 42, '7', new Date())).rejects.toThrow('execution_schedule_changed')
  })
})
