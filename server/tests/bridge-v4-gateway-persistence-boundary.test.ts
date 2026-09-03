import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Stage 12G persistence and lease boundaries', () => {
  it('counts live websocket profiles and fences the current account route in Redis', async () => {
    const source = await readFile(new URL('../src/modules/bridge/infrastructure/redis-bridge-gateway-lease-store.ts', import.meta.url), 'utf8')
    expect(source).toContain("redis.call('ZCARD',userKey)")
    expect(source).toContain('terminalProfileId')
    expect(source).toContain('connectionId')
    expect(source).toContain('accountKey')
    expect(source).toContain('profileConnection === route.connectionId')
    expect(source).not.toContain('purchasedAccounts')
  })

  it('opens only an owned bound route with a strictly newer numeric epoch', async () => {
    const source = await readFile(new URL('../src/modules/bridge/infrastructure/mysql-bridge-gateway-route-repository.ts', import.meta.url), 'utf8')
    expect(source).toContain("o.role='owner'")
    expect(source).toContain('p.installation_id=?')
    expect(source).toContain('b.terminal_instance_id=?')
    expect(source).toContain('connection_epoch_v4')
    expect(source).toContain('bridge_connection_epoch_stale')
    expect(source).toContain("'bridge_session_pending'")
    expect(source).toContain('SET disconnected_at_utc=NULL,disconnect_reason=NULL')
    expect(source).toContain('bridge_connection_epoch_superseded')
    expect(source.indexOf('INSERT INTO bridge_connection_sessions')).toBeLessThan(source.indexOf('async activate'))
  })

  it('persists the public projection, exact terminal snapshot, and absorption in one transaction', async () => {
    const source = await readFile(new URL('../src/modules/trading/infrastructure/mysql-trading-repository.ts', import.meta.url), 'utf8')
    expect(source).toContain('applyTrustedProjection')
    expect(source).toContain('bridge_trade_state_snapshots_v4')
    expect(source).toContain("status='committed'")
    expect(source).toContain("status='absorbed'")
    expect(source).toContain('trusted_projection_absorbed')
    expect(source.indexOf('bridge_connection_sessions')).toBeLessThan(source.indexOf('replaceExactTradeStates'))
  })

  it('builds commands from prepared intents and server-owned defaults, never from socket input', async () => {
    const source = await readFile(new URL('../src/modules/execution/infrastructure/mysql-execution-command-source.ts', import.meta.url), 'utf8')
    expect(source).toContain("i.status='prepared'")
    expect(source).toContain('snap.trade_permission=1')
    expect(source).toContain('bridge_trade_state_snapshots_v4')
    expect(source).toContain('BridgeExecutionDefaults')
    expect(source).toContain("active_command.status IN ('queued','dispatched','accepted','uncertain','reconciling')")
    expect(source).not.toMatch(/WebSocket|\.send\(|fetch\(|axios/i)
  })
})
