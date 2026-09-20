import { expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { resolveEntryEventClaims } from '../src/modules/inference/domain/entry-event-claims.js'
import { parseEntryEventPolicy } from '../src/modules/strategies/index.js'
import { contentHash } from '../src/modules/inference/index.js'
import { freezeEntryEventUsage } from '../src/modules/inference/application/entry-event-usage.js'
import { loadEntryEventClaims } from '../src/modules/inference/infrastructure/mysql-entry-event-claims.js'
import { inferenceTransaction } from '../src/modules/inference/infrastructure/mysql-inference-transaction.js'
import type { TraderDecisionResult } from '../src/modules/inference/domain/inference.js'

const id = 'event:' + 'a'.repeat(64)
function fixture() {
  const events = { M5: { state: 'ready', timeframe: 'M5', sourceAccountId: '9', symbol: 'XAUUSD', events: [{
    id, direction: 'up', confirmedAt: '2026-09-13T00:00:00.000Z', stillValid: true,
  }] } }
  const snapshot = { kind: 'trader', account: { id: '5' }, strategy: { id: '2', versionId: '3' },
    entryEventPolicy: { version: 1, mode: 'required', timeframe: 'M5' }, analysis: { id: 'analysis' },
    marketEntryEvents: { analysisId: 'analysis', sourceAccountId: '9', timeframes: events }, capturedAt: '2026-09-13T00:01:00.000Z' }
  const result = { actions: [{ actionId: 'open', kind: 'market_order', parameters: { entry_event_id: id, symbol: 'XAUUSD', side: 'buy' } as Record<string, unknown> }] }
  return { events, snapshot, result }
}

it('requires exact original event and permits pending-order direction from the order type', () => {
  const f = fixture()
  expect(resolveEntryEventClaims(f.result, f.snapshot)).toEqual([{ actionId: 'open', eventId: id, timeframe: 'M5', symbol: 'XAUUSD', side: 'buy', confirmedAt: '2026-09-13T00:00:00.000Z' }])
  f.result.actions[0]!.kind = 'pending_order'; delete f.result.actions[0]!.parameters.side
  f.result.actions[0]!.parameters.type = 'buy_stop'
  expect(resolveEntryEventClaims(f.result, f.snapshot)).toHaveLength(1)
})

it.each(['missing', 'invented', 'analysis', 'account', 'symbol', 'direction', 'future', 'invalidated', 'timeframe', 'duplicate', 'management'])('rejects incompatible event claim: %s', mode => {
  const f = fixture(), action = f.result.actions[0]!, event = f.events.M5.events[0]!
  if (mode === 'missing') delete action.parameters.entry_event_id
  if (mode === 'invented') action.parameters.entry_event_id = 'event:' + 'b'.repeat(64)
  if (mode === 'analysis') f.snapshot.marketEntryEvents.analysisId = 'other'
  if (mode === 'account') f.events.M5.sourceAccountId = 'other'
  if (mode === 'symbol') action.parameters.symbol = 'EURUSD'
  if (mode === 'direction') action.parameters.side = 'sell'
  if (mode === 'future') event.confirmedAt = '2026-09-14T00:00:00.000Z'
  if (mode === 'invalidated') event.stillValid = false
  if (mode === 'timeframe') f.snapshot.entryEventPolicy.timeframe = 'M15'
  if (mode === 'duplicate') f.result.actions.push({ ...action, actionId: 'second' })
  if (mode === 'management') action.kind = 'modify_position'
  expect(() => resolveEntryEventClaims(f.result, f.snapshot)).toThrow()
})

it('does not consume hold or impose an implicit event policy on historical strategies', () => {
  const f = fixture()
  expect(resolveEntryEventClaims({ actions: [] }, f.snapshot)).toEqual([])
  const { entryEventPolicy: _policy, ...snapshot } = f.snapshot
  delete f.result.actions[0]!.parameters.entry_event_id
  expect(resolveEntryEventClaims(f.result, snapshot)).toEqual([])
  expect(parseEntryEventPolicy(undefined)).toBeUndefined()
  for (const bad of [null, true, { version: 2, mode: 'required', timeframe: 'M5' }, { version: 1, mode: 'required', timeframe: 'M5', retry: true }]) {
    expect(() => parseEntryEventPolicy(bad)).toThrow('entry_event_policy_invalid')
  }
})

it('binds usage reads to user/account/strategy and distinguishes absence from an unavailable reader', async () => {
  const f = fixture(), scope = { userId: 7, accountId: '5', strategyId: '2' }, read = vi.fn(async () => ({ coverageStartUtc: '2026-09-12T00:00:00.000Z', items: [{ eventId: id, state: 'consumed' as const }] }))
  expect(await freezeEntryEventUsage(scope, f.events, { read })).toMatchObject({ state: 'read', items: [{ eventId: id, state: 'consumed' }] })
  expect(read).toHaveBeenCalledWith({ ...scope, eventIds: [id] })
  expect(await freezeEntryEventUsage(scope, f.events, { read: async () => ({ coverageStartUtc: '2026-09-12T00:00:00.000Z', items: [] }) })).toMatchObject({ items: [{ state: 'available' }] })
  expect(await freezeEntryEventUsage(scope, f.events)).toEqual({ schemaVersion: 1, state: 'unavailable' })
  await expect(freezeEntryEventUsage(scope, f.events, { read: async () => ({ coverageStartUtc: '2026-09-12T00:00:00.000Z', items: [{ eventId: 'other', state: 'reserved' }] }) })).rejects.toThrow('entry_event_usage_invalid')
})

it('reloads the frozen trader snapshot and rejects hash or scope substitution before ledger access', async () => {
  const f = fixture(), row = { payload_json: f.snapshot, payload_sha256: contentHash(f.snapshot) }, execute = vi.fn(async (sql: string) => sql.includes('database_upgrade_steps_v4') ? [[{ completed_at: '2026-09-12T00:00:00.000Z' }]] : [[row]])
  const scope = { userId: 7, accountId: '5', strategyId: '2', strategyVersionId: '3', snapshotId: 'snapshot' }
  const load = () => loadEntryEventClaims({ execute } as unknown as PoolConnection, scope, f.result as unknown as TraderDecisionResult)
  expect(await load()).toHaveLength(1)
  expect(execute.mock.calls[0]).toEqual([expect.stringContaining("s.purpose='trader'"), ['snapshot', 7, '5', '2', '3']])
  row.payload_json.account.id = '6'; row.payload_sha256 = contentHash(row.payload_json)
  await expect(load()).rejects.toThrow('entry_event_snapshot_invalid')
  row.payload_json.account.id = '5'; row.payload_sha256 = '0'.repeat(64)
  await expect(load()).rejects.toThrow('entry_event_snapshot_invalid')
})

it.each(['commit', 'work', 'start', 'rollback'])('handles %s failure without unsafe reuse', async mode => {
  const db = { beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), destroy: vi.fn(), release: vi.fn() }
  const work = vi.fn(async () => 'done')
  if (mode === 'commit') db.commit.mockRejectedValueOnce(Error('lost acknowledgement'))
  if (mode === 'start') db.beginTransaction.mockRejectedValueOnce(Error('start failed'))
  if (mode === 'work' || mode === 'rollback') work.mockRejectedValueOnce(Error('work failed'))
  if (mode === 'rollback') db.rollback.mockRejectedValueOnce(Error('rollback failed'))
  await expect(inferenceTransaction({ getConnection: async () => db } as unknown as Pool, work)).rejects.toThrow(
    mode === 'commit' ? 'inference_commit_unknown' : mode === 'start' ? 'inference_storage_unavailable' : mode === 'rollback' ? 'inference_rollback_unknown' : 'work failed')
  if (mode === 'commit' || mode === 'start') expect(db.rollback).not.toHaveBeenCalled()
  if (mode === 'work') { expect(db.release).toHaveBeenCalledOnce(); expect(db.destroy).not.toHaveBeenCalled() }
  else { expect(db.destroy).toHaveBeenCalledOnce(); expect(db.release).not.toHaveBeenCalled() }
})


it('does not interpret an absent pre-cutover claim as unused, and blocks it again during registration', async () => {
  const f = fixture(), cutoff = '2026-09-13T00:01:00.000Z'
  const usage = await freezeEntryEventUsage({ userId: 7, accountId: '5', strategyId: '2' }, f.events,
    { read: async () => ({ coverageStartUtc: cutoff, items: [] }) })
  expect(usage).toMatchObject({ items: [{ eventId: id, state: 'unknown' }] })
  const execute = vi.fn(async (sql: string) => sql.includes('database_upgrade_steps_v4')
    ? [[{ completed_at: cutoff }]] : [[{ payload_json: f.snapshot, payload_sha256: contentHash(f.snapshot) }]])
  await expect(loadEntryEventClaims({ execute } as unknown as PoolConnection,
    { userId: 7, accountId: '5', strategyId: '2', strategyVersionId: '3', snapshotId: 'snapshot' }, f.result as unknown as TraderDecisionResult))
    .rejects.toThrow('entry_event_history_unavailable')
})
