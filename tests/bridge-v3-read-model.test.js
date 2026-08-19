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
    upserts:stream === 'account'
      ? [{ login:'12345678', server:'Broker-Demo', balance:1000, equity:995 }]
      : [{ ticket:'1001', symbol:'XAUUSD' }],
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

  it('persists installation-level release telemetry idempotently with the terminal session', async () => {
    const { run, transactionFn } = transactionFor({ terminal:null })
    await registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL06', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'12345678', connectionEpoch:7,
      clientVersion:'5.0.5735', bridgeVersion:'3.1.0',
      installationId:'install_0123456789abcdef0123456789abcdef',
      updateReport:{
        release_id:'bridge-3.1.0-20260728.1', target_version:'3.1.0', state:'healthy',
        started_at_utc_msc:NOW - 60_000, updated_at_utc_msc:NOW,
      },
      nowUtcMsc:NOW,
    }, { transactionFn })
    expect(run.mock.calls.some(([sql]) => sql.includes('bridge_version, installation_id'))).toBe(true)
    expect(run.mock.calls.some(([sql]) => sql.includes('INSERT IGNORE INTO bridge_update_events'))).toBe(true)
  })

  it('rejects stale epochs and accepts a fenced same-user account rebind', async () => {
    const stale = transactionFor({ terminal:terminalRow({ connection_epoch:8 }) })
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL02', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'12345678', connectionEpoch:7,
    }, { transactionFn:stale.transactionFn })).rejects.toMatchObject({ code:'bridge_connection_epoch_stale' })

    const rebound = transactionFor()
    const result = await registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL02', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'999', connectionEpoch:8,
    }, { transactionFn:rebound.transactionFn })
    expect(result).toMatchObject({
      accountRebound:true, ownerRebound:false, rebound:false, resumed:false,
      previousRoute:expect.objectContaining({ login:'12345678', connectionEpoch:7 }),
    })
    const sql = rebound.run.mock.calls.map(([value]) => value)
    for (const table of [
      'bridge_v3_stream_revisions', 'bridge_v3_account_latest', 'bridge_v3_positions_latest',
      'bridge_v3_orders_latest', 'bridge_v3_deals',
    ]) {
      expect(sql.some(value => value.includes(`DELETE FROM ${table}`))).toBe(true)
    }
    expect(sql.find(value => value.includes('INSERT INTO bridge_v3_terminal_sessions')))
      .toContain('broker_server = VALUES(broker_server)')
  })

  it('rejects account changes without a strictly newer epoch and rejects platform changes', async () => {
    const sameEpoch = transactionFor()
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL02', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'999', connectionEpoch:7,
    }, { transactionFn:sameEpoch.transactionFn })).rejects.toMatchObject({ code:'bridge_connection_epoch_stale' })

    const changedPlatform = transactionFor()
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL02', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt4', brokerServer:'Broker-Demo', login:'12345678', connectionEpoch:8,
    }, { transactionFn:changedPlatform.transactionFn }))
      .rejects.toMatchObject({ code:'bridge_terminal_binding_mismatch' })
  })

  it('accepts a same-user broker-server change only with a newer epoch', async () => {
    const rebound = transactionFor()
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL02', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Live', login:'12345678', connectionEpoch:8,
    }, { transactionFn:rebound.transactionFn })).resolves.toMatchObject({
      accountRebound:true,
      brokerServer:'Broker-Live',
      previousRoute:expect.objectContaining({ brokerServer:'Broker-Demo' }),
    })
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

  it('rebinds a disconnected terminal profile even when its isolated epoch is lower', async () => {
    const rebound = transactionFor({ terminal:terminalRow({
      user_id:29,
      connection_epoch:8,
      connected:'0',
    }) })

    await expect(registerBridgeTerminalSession({
      userId:42,
      sessionId:'session_01JREADMODEL03',
      terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5',
      brokerServer:'Broker-Demo',
      login:'12345678',
      connectionEpoch:3,
      nowUtcMsc:NOW + 200,
    }, { transactionFn:rebound.transactionFn })).resolves.toMatchObject({
      connected:true,
      resumed:false,
      rebound:true,
      ownerRebound:true,
      accountRebound:false,
      userId:42,
    })
    for (const table of [
      'bridge_v3_stream_revisions', 'bridge_v3_account_latest', 'bridge_v3_positions_latest',
      'bridge_v3_orders_latest', 'bridge_v3_deals',
    ]) {
      expect(rebound.run.mock.calls.some(([sql]) => sql.includes(`DELETE FROM ${table}`))).toBe(true)
    }
    expect(rebound.run.mock.calls.some(([sql]) => sql.includes('user_id = VALUES(user_id)'))).toBe(true)
  })

  it('does not rebind an active terminal session and keeps same-user epoch fencing', async () => {
    const active = transactionFor({ terminal:terminalRow({ user_id:29, connection_epoch:8, connected:1 }) })
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL04', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'12345678', connectionEpoch:9,
    }, { transactionFn:active.transactionFn })).rejects.toMatchObject({ code:'bridge_terminal_binding_mismatch' })

    const crossUserRouteChange = transactionFor({ terminal:terminalRow({ user_id:29, connected:0 }) })
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL04', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'999', connectionEpoch:9,
    }, { transactionFn:crossUserRouteChange.transactionFn }))
      .rejects.toMatchObject({ code:'bridge_terminal_binding_mismatch' })

    const stale = transactionFor({ terminal:terminalRow({ user_id:42, connection_epoch:8, connected:0 }) })
    await expect(registerBridgeTerminalSession({
      userId:42, sessionId:'session_01JREADMODEL05', terminalInstanceId:'terminal_01JREADMODEL1',
      platform:'mt5', brokerServer:'Broker-Demo', login:'12345678', connectionEpoch:7,
    }, { transactionFn:stale.transactionFn })).rejects.toMatchObject({ code:'bridge_connection_epoch_stale' })
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
      deletes:[],
    })
    const { run, transactionFn } = transactionFor({ revision:{ revision:12 } })
    await expect(applyBridgeDataDelta(message, { userId:42, nowUtcMsc:NOW, transactionFn }))
      .resolves.toMatchObject({ status:'applied', revision:20 })
    const sql = run.mock.calls.map(([value]) => value)
    expect(sql.some(value => value.includes('DELETE FROM bridge_v3_positions_latest WHERE terminal_instance_id'))).toBe(true)
    expect(sql.some(value => value.includes('INSERT INTO bridge_v3_positions_latest'))).toBe(true)
  })

  it('persists immutable deals without deleting historical rows on a full snapshot', async () => {
    const message = delta('deals', {
      revision:1,
      base_revision:0,
      full_snapshot:true,
      upserts:[{
        ticket:'5001', order:'4001', position_id:'3001', symbol:'XAUUSD',
        time_msc:NOW - 100, profit:12.5,
      }],
      deletes:[],
    })
    const { run, transactionFn } = transactionFor()

    await expect(applyBridgeDataDelta(message, { userId:42, nowUtcMsc:NOW, transactionFn }))
      .resolves.toMatchObject({ status:'applied', stream:'deals', revision:1 })

    const sql = run.mock.calls.map(([value]) => value)
    expect(sql.some(value => value.includes('INSERT INTO bridge_v3_deals'))).toBe(true)
    expect(sql.some(value => value.includes('DELETE FROM bridge_v3_deals'))).toBe(false)
    expect(run.mock.calls.find(([value]) => value.includes('INSERT INTO bridge_v3_deals'))[1])
      .toEqual(expect.arrayContaining(['5001', 42, '4001', '3001', 'XAUUSD', NOW - 100]))
  })

  it('accepts symbol-less balance events without poisoning the deals revision', async () => {
    const message = delta('deals', {
      upserts:[{
        ticket:'5002', deal_ticket:'5002', order_ticket:'5002', position_id:'5002',
        symbol:'', category:'balance', time_msc:NOW - 50,
      }],
      deletes:[],
    })
    const { run, transactionFn } = transactionFor()

    await expect(applyBridgeDataDelta(message, { userId:42, nowUtcMsc:NOW, transactionFn }))
      .resolves.toMatchObject({ status:'applied', stream:'deals', revision:1 })

    expect(run.mock.calls.find(([value]) => value.includes('INSERT INTO bridge_v3_deals'))[1])
      .toEqual(expect.arrayContaining(['5002', 42, '5002', '5002', null, NOW - 50]))
  })

  it('rejects deletes and missing source times in the deals stream', async () => {
    const deleted = transactionFor()
    await expect(applyBridgeDataDelta(delta('deals', {
      upserts:[{ ticket:'5001', time_msc:NOW - 100 }], deletes:['5000'],
    }), { userId:42, nowUtcMsc:NOW, transactionFn:deleted.transactionFn }))
      .rejects.toMatchObject({ code:'bridge_deals_delete_invalid' })

    const missingTime = transactionFor()
    await expect(applyBridgeDataDelta(delta('deals', {
      upserts:[{ ticket:'5001' }],
    }), { userId:42, nowUtcMsc:NOW, transactionFn:missingTime.transactionFn }))
      .rejects.toMatchObject({ code:'bridge_deals_time_invalid' })
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
