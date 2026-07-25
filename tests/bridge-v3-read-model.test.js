import { describe, expect, it, vi } from 'vitest'

import { applyBridgeDataDelta, registerBridgeTerminalSession } from '../server/bridge-v3/read-model.js'
import { sha256Json } from '../server/bridge-v3/command-ledger.js'

const NOW = 1_800_000_000_000

function terminalRow(overrides = {}) {
  return {
    terminal_instance_id:'terminal_01JREADMODEL1',
    user_id:42,
    platform:'mt5',
    broker_server:'Broker-Demo',
    login_account:'12345678',
    connection_epoch:7,
    session_id:'session_01JREADMODEL01',
    connected:1,
    ...overrides,
  }
}

function delta(stream = 'positions', overrides = {}) {
  return {
    v:3,
    type:'data_delta',
    message_id:`msg_01JREADMODEL_${stream}`,
    sent_at_utc_msc:NOW,
    terminal_instance_id:'terminal_01JREADMODEL1',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    stream,
    revision:1,
    base_revision:0,
    observed_at_utc_msc:NOW,
    source_time_msc:NOW - 20,
    full_snapshot:false,
    upserts:stream === 'account' ? [{ balance:1000, equity:995 }] : [{ ticket:'1001', symbol:'XAUUSD' }],
    deletes:[],
    ...overrides,
  }
}

function transactionFor({ terminal = terminalRow(), revision = null } = {}) {
  const run = vi.fn(async sql => {
    if (sql.includes('SELECT * FROM bridge_v3_terminal_sessions')) return [[terminal].filter(Boolean), []]
    if (sql.includes('SELECT * FROM bridge_v3_stream_revisions')) return [[revision].filter(Boolean), []]
    return [[{ affectedRows:1 }], []]
  })
  return { run, transactionFn:fn => fn(run) }
}

describe('Bridge v3 incremental read model', () => {
  it('registers a new terminal session with an immutable account route', async () => {
    const { run, transactionFn } = transactionFor({ terminal:null })
    await expect(registerBridgeTerminalSession({
      userId:42,
      sessionId:'session_01JREADMODEL01',
      terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'MT5',
      brokerServer:'Broker-Demo',
      login:'12345678',
      connectionEpoch:7,
      nowUtcMsc:NOW,
    }, { transactionFn })).resolves.toMatchObject({ connected:true, resumed:false, platform:'mt5' })
    expect(run.mock.calls[1][0]).toContain('INSERT INTO bridge_v3_terminal_sessions')
  })

  it('rejects stale epochs and account rebinding hidden inside a reconnect', async () => {
    const stale = transactionFor({ terminal:terminalRow({ connection_epoch:8 }) })
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL02', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'12345678', connectionEpoch:7,
    }, { transactionFn:stale.transactionFn })).rejects.toMatchObject({ code:'bridge_connection_epoch_stale' })

    const rebound = transactionFor()
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL02', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'999', connectionEpoch:8,
    }, { transactionFn:rebound.transactionFn })).rejects.toMatchObject({ code:'bridge_terminal_binding_mismatch' })
  })

  it('resumes the same terminal epoch under a new websocket session', async () => {
    const reconnect = transactionFor()
    await expect(registerBridgeTerminalSession({
      userId:42,
      sessionId:'session_01JREADMODEL02',
      terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5',
      brokerServer:'Broker-Demo',
      login:'12345678',
      connectionEpoch:7,
      nowUtcMsc:NOW + 100,
    }, { transactionFn:reconnect.transactionFn })).resolves.toMatchObject({
      connected:true,
      resumed:true,
      connectionEpoch:7,
      sessionId:'session_01JREADMODEL02',
    })
    expect(reconnect.run.mock.calls[1][1]).toEqual(expect.arrayContaining([
      'terminal_01JREADMODEL1', 'session_01JREADMODEL02', 7,
    ]))
  })

  it('applies account latest state and advances its revision in one transaction', async () => {
    const message = delta('account')
    const { run, transactionFn } = transactionFor()
    await expect(applyBridgeDataDelta(message, { userId:42, nowUtcMsc:NOW, transactionFn }))
      .resolves.toEqual({ status:'applied', stream:'account', revision:1, expected_revision:2 })
    expect(run.mock.calls.some(([sql]) => sql.includes('INSERT INTO bridge_v3_account_latest'))).toBe(true)
    expect(run.mock.calls.some(([sql]) => sql.includes('INSERT INTO bridge_v3_stream_revisions'))).toBe(true)
    expect(run.mock.calls.at(-1)[0]).toContain('UPDATE bridge_v3_terminal_sessions')
  })

  it('applies position upserts/deletes and replaces a full snapshot', async () => {
    const message = delta('positions', {
      revision:20,
      base_revision:0,
      full_snapshot:true,
      upserts:[{ ticket:'1001' }, { position_id:'1002' }],
      deletes:['999'],
    })
    const { run, transactionFn } = transactionFor({ revision:{ revision:12 } })
    await expect(applyBridgeDataDelta(message, { userId:42, nowUtcMsc:NOW, transactionFn }))
      .resolves.toMatchObject({ status:'applied', revision:20 })
    const sql = run.mock.calls.map(([value]) => value)
    expect(sql.some(value => value.includes('DELETE FROM bridge_v3_positions_latest WHERE terminal_instance_id'))).toBe(true)
    expect(sql.some(value => value.includes('INSERT INTO bridge_v3_positions_latest'))).toBe(true)
    expect(sql.some(value => value.includes('ticket IN'))).toBe(true)
  })

  it('returns a gap without mutating latest state when the base revision is stale', async () => {
    const { run, transactionFn } = transactionFor({ revision:{ revision:4 } })
    await expect(applyBridgeDataDelta(delta('orders', { revision:6, base_revision:5 }), {
      userId:42, nowUtcMsc:NOW, transactionFn,
    })).resolves.toEqual({ status:'gap', stream:'orders', revision:6, expected_revision:5 })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('acknowledges an identical replay and rejects a conflicting revision', async () => {
    const message = delta('positions')
    const identical = transactionFor({ revision:{ revision:1, payload_hash:sha256Json(message) } })
    await expect(applyBridgeDataDelta(message, { userId:42, nowUtcMsc:NOW, transactionFn:identical.transactionFn }))
      .resolves.toEqual({ status:'duplicate', stream:'positions', revision:1, expected_revision:2 })

    const conflict = transactionFor({ revision:{ revision:1, payload_hash:'f'.repeat(64) } })
    await expect(applyBridgeDataDelta(message, { userId:42, nowUtcMsc:NOW, transactionFn:conflict.transactionFn }))
      .rejects.toMatchObject({ code:'bridge_data_revision_conflict' })
  })

  it('rejects data from another user, account, terminal route, or inactive session', async () => {
    for (const options of [
      { userId:99, terminal:terminalRow() },
      { userId:42, terminal:terminalRow({ login_account:'999' }) },
      { userId:42, terminal:terminalRow({ connection_epoch:8 }) },
      { userId:42, terminal:terminalRow({ connected:0 }) },
    ]) {
      const tx = transactionFor({ terminal:options.terminal })
      await expect(applyBridgeDataDelta(delta(), {
        userId:options.userId, nowUtcMsc:NOW, transactionFn:tx.transactionFn,
      })).rejects.toHaveProperty('code')
      expect(tx.run).toHaveBeenCalledTimes(1)
    }
  })
})
