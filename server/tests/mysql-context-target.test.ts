import { createAccountPrincipalReader } from '../src/modules/auth/composition.js'
import { expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { prepareMysqlContextTarget } from '../src/modules/trading/infrastructure/mysql-context-target.js'
import type { ContextWriteCommand } from '../src/modules/trading/domain/context-write.js'

const command: ContextWriteCommand = { userId: 42, requestId: 'd97382ac-4b49-42db-b1f1-850ec403848a', action: 'select_account', targetId: '7', expectedRevision: 0 }
function fixture() {
  let candidate: string | null = '7', inTransaction = false, permissionEpoch = 4
  const calls: Array<{ sql: string; scope: string; params: unknown[] }> = []
  const route = { userId: 42, accountId: '7', platform: 'mt5' as const, brokerServer: 'Demo', login: '100', terminalProfileId: 'profile-a',
    terminalInstanceId: 'instance-a', connectionEpoch: 4, connectionId: 'connection-a', sessionId: 'session-a', timezoneOffsetMinutes: 0,
    installationId: 'installation-a', credentialGeneration: 1, ownershipRevision: '3' }
  const leases = { current: vi.fn(async () => {
    if (inTransaction) throw Error('network-inside-transaction')
    return route
  }) }
  const execute = (scope: string) => async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, scope, params })
    if (sql.startsWith('SELECT CAST(a.id AS CHAR) account_id')) return [candidate ? [{ account_id: candidate }] : [], []]
    if (sql.includes('SELECT s.last_seen_at_utc')) return [[{ last_seen_at_utc: new Date() }], []]
    if (sql.includes('FROM account_runtime_snapshots snap')) return [[{ revision: 4, source_user_id: 42, source_interval_id: 'interval-a',
      source_ownership_revision: 3, source_profile_id: 'profile-a', source_instance_id: 'instance-a', source_connection_epoch: permissionEpoch,
      projection_revision: 4, trade_permission: 1 }], []]
    if (sql.includes('FROM observer_channels c')) return [[], []]
    if (sql.includes('FROM trading_accounts a')) return [[{ id: '7', platform: 'mt5', account_login: '100', broker_server: 'Demo', currency: 'USD',
      owner_user_id: 42, ownership_interval_id: 'interval-a', ownership_revision: 3, profile_id: 'profile-a', terminal_instance_id: 'instance-a',
      bridge_state: 'offline', trade_permission: 0, snapshot_trade_permission: 0, connection_paused: 0, last_seen_at_utc: null }], []]
    throw Error('unexpected-sql')
  }
  return { pool: { execute: execute('pool') } as unknown as Pool, connection: { execute: execute('connection') } as unknown as PoolConnection,
    leases, route, calls, enter: () => { inTransaction = true }, candidate: (value: string | null) => { candidate = value },
    permissionEpoch: (value: number) => { permissionEpoch = value } }
}

it('captures route outside the transaction and reuses exact repository permission checks on its connection', async () => {
  const f = fixture()
  const resolve = await prepareMysqlContextTarget(f.pool, f.leases, command, createAccountPrincipalReader)
  f.enter()
  expect(await resolve(f.connection, command)).toEqual({ userId: 42, mode: 'full', accountId: '7', observerChannelId: null, readOnly: false })
  expect(f.leases.current).toHaveBeenCalledTimes(1)
  expect(f.calls.filter(call => call.scope === 'pool')).toHaveLength(1)
  expect(f.calls.find(call => call.scope === 'connection')!.sql).toContain('FOR SHARE')
  expect(f.calls.some(call => call.scope === 'connection' && call.sql.includes('projection_provenance_v4'))).toBe(true)
})

it('keeps an owned account readable when its current projection does not match the route epoch', async () => {
  const f = fixture()
  const resolve = await prepareMysqlContextTarget(f.pool, f.leases, command, createAccountPrincipalReader)
  f.permissionEpoch(5); f.enter()
  expect(await resolve(f.connection, command)).toMatchObject({ mode: 'full', accountId: '7', readOnly: true })
})

it('does not use later mutation of the external route object to authorize a different epoch', async () => {
  const f = fixture()
  const resolve = await prepareMysqlContextTarget(f.pool, f.leases, command, createAccountPrincipalReader)
  f.route.connectionEpoch = 5; f.permissionEpoch(5); f.enter()
  expect(await resolve(f.connection, command)).toMatchObject({ readOnly: true })
  expect(f.leases.current).toHaveBeenCalledTimes(1)
})

it('rejects changed ownership candidates and mismatched prepared commands', async () => {
  const f = fixture()
  const resolve = await prepareMysqlContextTarget(f.pool, f.leases, command, createAccountPrincipalReader)
  f.candidate(null); f.enter()
  await expect(resolve(f.connection, command)).rejects.toMatchObject({ code: 'revision_conflict' })
  await expect(resolve(f.connection, { ...command, targetId: '8' })).rejects.toMatchObject({ code: 'trading_context_invalid' })
})

it('exits observation to blocked when no owned account exists without checking revoked observation access', async () => {
  const f = fixture(); f.candidate(null)
  const leave = { ...command, action: 'leave_observer' as const, targetId: null }
  const resolve = await prepareMysqlContextTarget(f.pool, f.leases, leave, createAccountPrincipalReader)
  f.enter()
  expect(await resolve(f.connection, leave)).toMatchObject({ mode: 'blocked', readOnly: true, accountId: null })
  expect(f.leases.current).not.toHaveBeenCalled()
  expect(f.calls.every(call => !call.sql.includes('observer_channels'))).toBe(true)
})

it('rechecks observation through the existing authorization reader on the supplied connection', async () => {
  const f = fixture()
  const observe = { ...command, action: 'enter_observer' as const, targetId: '12' }
  const resolve = await prepareMysqlContextTarget(f.pool, f.leases, observe, createAccountPrincipalReader)
  f.enter()
  await expect(resolve(f.connection, observe)).rejects.toMatchObject({ code: 'trading_account_forbidden' })
  expect(f.leases.current).not.toHaveBeenCalled()
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]).toMatchObject({ scope: 'connection' })
  expect(f.calls[0]!.sql).toContain('FOR SHARE')
})
