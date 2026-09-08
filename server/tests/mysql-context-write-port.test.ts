import { createActivePrincipalAccess } from '../src/modules/auth/composition.js'
import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createTradingContextWriter } from '../src/modules/trading/composition.js'
import type { ContextWriteCommand } from '../src/modules/trading/domain/context-write.js'

const command: ContextWriteCommand = { userId: 42, requestId: 'd97382ac-4b49-42db-b1f1-850ec403848a', action: 'select_account', targetId: '7', expectedRevision: 0 }

function fixture() {
  let rows: Record<string, Record<string, unknown>> = {}, revision = 0, active = true
  let lostAck = false, prepareFails = false, connectionFails = false, removed = false
  let observerAllowed = false
  let duringRoute: (() => void) | undefined
  let betweenReads: (() => void) | undefined
  const calls: string[] = []
  let transactions = 0
  const leases = { current: vi.fn(async () => {
    calls.push('route')
    duringRoute?.()
    if (transactions) throw Error('network-in-transaction')
    return null
  }) }
  const target = async (sql: string, _values: unknown[] = []) => {
    if (sql.includes('FROM observer_channels c')) return [observerAllowed ? [{
      channel_id: '12', display_name: 'Observation', channel_slug: 'gold', source_id: '13', source_trading_account_id: '7', source_account_id: '7', ownership_revision: '4',
      channel_active: 1, channel_revision: '3', audience: 'all', source_revision: '2', source_status: 'active', source_configuration_status: 'ready',
      operator_user_id: 42, operator_deletion_status: 'active', operator_deleted_at: null, account_deleted_at: null,
      viewer_deletion_status: 'active', viewer_deleted_at: null, viewer_plan: 'free', viewer_plan_expires_at: null, viewer_token_version: 1,
      access_granted_at_utc: null, access_revoked_at_utc: null, access_revision: null,
    }] : []]
    if (sql.startsWith('SELECT CAST(a.id AS CHAR) account_id')) {
      calls.push(transactions ? 'locked-target' : 'prepare-target')
      if (!transactions && prepareFails) throw Error('private-driver-details')
      return [removed ? [] : [{ account_id: '7' }]]
    }
    if (sql.includes('FROM trading_accounts a')) return [[{ id: '7', platform: 'mt5', account_login: '100', broker_server: 'Demo', currency: 'USD',
      owner_user_id: 42, ownership_interval_id: 'interval-a', ownership_revision: 3, profile_id: null, terminal_instance_id: null,
      bridge_state: 'offline', trade_permission: 0, snapshot_trade_permission: 0, connection_paused: 0, last_seen_at_utc: null }]]
    throw Error('unexpected-target-query')
  }
  const pool = {
    execute: target,
    async getConnection() {
      if (connectionFails) throw Error('private-connection-details')
      let pending = structuredClone(rows), nextRevision = revision, transaction = false
      return {
        async beginTransaction() {
          calls.push('begin')
          pending = structuredClone(rows); nextRevision = revision; transaction = true; transactions++
        },
        async execute(sql: string, values: unknown[]) {
          if (sql.startsWith('SELECT id FROM users')) {
            if (sql.endsWith('FOR UPDATE')) {
              betweenReads?.(); betweenReads = undefined
              pending = structuredClone(rows); nextRevision = revision
            }
            return [active ? [{ id: 42 }] : []]
          }
          if (sql.includes('FROM trading_context_changes_v4')) {
            calls.push('read-receipt')
            const row = pending[String(values[1])]
            return [active && row ? [row] : []]
          }
          if (sql.includes('FROM trading_contexts')) return [nextRevision ? [{ revision: String(nextRevision) }] : []]
          if (sql.includes('INSERT INTO trading_contexts')) { calls.push('write'); nextRevision = Number(values[5]); return [{ affectedRows: 1 }] }
          if (sql.includes('INSERT INTO trading_context_changes_v4')) {
            const names = ['user_id','request_id','request_sha256','action','target_id','prior_revision','revision','result_mode','result_account_id','result_observer_channel_id','result_read_only']
            pending[String(values[1])] = { ...Object.fromEntries(names.map((name, index) => [name, values[index]])), recorded_at: '2026-09-08T12:00:00.000Z' }
            return [{ affectedRows: 1 }]
          }
          return target(sql, values)
        },
        async commit() {
          calls.push('commit'); rows = structuredClone(pending); revision = nextRevision
          if (transaction) { transaction = false; transactions-- }
          if (lostAck) { lostAck = false; throw Error('ack-lost') }
        },
        async rollback() { calls.push('rollback'); if (transaction) { transaction = false; transactions-- } },
        release() { calls.push('release') },
        destroy() { calls.push('destroy'); if (transaction) { transaction = false; transactions-- } },
      }
    },
  }
  return {
    port: createTradingContextWriter(pool as unknown as Pool, leases, createActivePrincipalAccess), calls, leases,
    revision: () => revision, lostAck: () => { lostAck = true }, failPreparation: () => { prepareFails = true },
    failConnection: () => { connectionFails = true }, removeTarget: () => { removed = true },
    onRoute: (callback: () => void) => { duringRoute = callback },
    deactivate: () => { active = false }, beforeTransaction: (callback: () => void) => { betweenReads = callback },
    removeReceipt: () => { rows = {} },
    allowObserver: () => { observerAllowed = true },
  }
}

it('composes the real target and transaction writer without holding a transaction during route collection', async () => {
  const f = fixture()
  await expect(f.port.execute(command)).resolves.toMatchObject({ replayed: false, result: { accountId: '7', revision: 1, readOnly: true } })
  expect(f.calls.indexOf('route')).toBeLessThan(f.calls.lastIndexOf('begin'))
  expect(f.calls.indexOf('rollback')).toBeLessThan(f.calls.indexOf('route'))
  expect(f.calls.indexOf('locked-target')).toBeGreaterThan(f.calls.lastIndexOf('begin'))
  expect(f.leases.current).toHaveBeenCalledTimes(1)
  expect(f.revision()).toBe(1)
})

it('recovers a lost commit acknowledgment without requiring the historical target or route', async () => {
  const f = fixture(); f.lostAck()
  await expect(f.port.execute(command)).rejects.toMatchObject({ code: 'trading_context_commit_unknown' })
  expect(f.calls).toContain('destroy')
  f.removeTarget(); f.failPreparation()
  await expect(f.port.receipt(42, command.requestId)).resolves.toMatchObject({ result: { revision: 1 } })
  await expect(f.port.execute(command)).resolves.toMatchObject({ replayed: true, result: { accountId: '7', revision: 1 } })
  expect(f.calls.filter(call => call === 'write')).toHaveLength(1)
  expect(f.leases.current).toHaveBeenCalledTimes(1)
})

it('checks the digest even when the historical target can no longer be prepared', async () => {
  const f = fixture(); await f.port.execute(command); f.failPreparation()
  await expect(f.port.execute({ ...command, targetId: '8' })).rejects.toMatchObject({ code: 'trading_context_idempotency_conflict', status: 409 })
  expect(f.revision()).toBe(1)
})

it('rechecks user revocation after the preliminary receipt read under the transaction lock', async () => {
  const f = fixture(); await f.port.execute(command)
  f.beforeTransaction(f.deactivate)
  await expect(f.port.execute(command)).rejects.toMatchObject({ code: 'trading_account_forbidden', status: 403 })
  expect(f.revision()).toBe(1)
})

it('fails closed if a historical receipt disappears before its locked replay', async () => {
  const f = fixture(); await f.port.execute(command)
  f.beforeTransaction(f.removeReceipt)
  await expect(f.port.execute(command)).rejects.toMatchObject({ code: 'revision_conflict' })
  expect(f.calls.filter(call => call === 'write')).toHaveLength(1)
})

it('rechecks a new command target after external collection and rolls back on ownership change', async () => {
  const f = fixture(); f.beforeTransaction(f.removeTarget)
  await expect(f.port.execute(command)).rejects.toMatchObject({ code: 'revision_conflict' })
  expect(f.calls).toContain('rollback')
  expect(f.calls).not.toContain('write')
})

it('normalizes and freezes the command before asynchronous preparation', async () => {
  const f = fixture(), input = { ...command }
  const pending = f.port.execute(input)
  input.targetId = '8'; input.expectedRevision = 9
  await expect(pending).resolves.toMatchObject({ targetId: '7', priorRevision: 0, result: { accountId: '7' } })
})

it('rejects invalid commands without I/O and sanitizes preparation and receipt failures', async () => {
  const f = fixture()
  await expect(f.port.execute({ ...command, requestId: 'invalid' })).rejects.toMatchObject({ code: 'trading_context_invalid', status: 400 })
  expect(f.calls).toEqual([])
  f.failPreparation()
  await expect(f.port.execute(command)).rejects.toMatchObject({ message: 'trading_context_write_failed', status: 503 })
  expect(f.calls.filter(call => call === 'begin')).toHaveLength(1)
  expect(f.calls.indexOf('rollback')).toBeLessThan(f.calls.indexOf('prepare-target'))
  expect(f.calls).not.toContain('write')
  f.failConnection()
  await expect(f.port.receipt(42, command.requestId)).rejects.toMatchObject({ message: 'trading_context_receipt_unavailable', status: 503 })
})

it('uses real observer authorization for both accepted and denied commands without collecting a personal route', async () => {
  const observe = { ...command, action: 'enter_observer' as const, targetId: '12' }
  const denied = fixture()
  await expect(denied.port.execute(observe)).rejects.toMatchObject({ code: 'trading_account_forbidden' })
  expect(denied.calls).not.toContain('write')
  const accepted = fixture(); accepted.allowObserver()
  await expect(accepted.port.execute(observe)).resolves.toMatchObject({ result: { mode: 'observer', accountId: null, observerChannelId: '12', readOnly: true } })
  expect(accepted.leases.current).not.toHaveBeenCalled()
  expect(accepted.revision()).toBe(1)
})


it('rejects a user revoked during external route capture before locking the target or writing', async () => {
  const f = fixture(); f.onRoute(f.deactivate)
  await expect(f.port.execute(command)).rejects.toMatchObject({ code: 'trading_account_forbidden', status: 403 })
  expect(f.leases.current).toHaveBeenCalledOnce()
  expect(f.calls).toContain('prepare-target')
  expect(f.calls).not.toContain('locked-target')
  expect(f.calls).not.toContain('write')
  expect(f.revision()).toBe(0)
})

it('does not collect a route or query a candidate for an already revoked user', async () => {
  const f = fixture(); f.deactivate()
  await expect(f.port.execute(command)).rejects.toMatchObject({ code: 'trading_account_forbidden', status: 403 })
  expect(f.leases.current).not.toHaveBeenCalled()
  expect(f.calls).not.toContain('prepare-target')
  expect(f.calls).not.toContain('write')
})
