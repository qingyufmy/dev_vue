import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import {
  BRIDGE_V3_CONNECTION_STALE_MS,
  BRIDGE_V3_WS_PATH,
  createBridgeV3Gateway,
} from '../server/bridge-v3/gateway.js'

const NOW = 1_800_000_000_000

class FakeWebSocketServer extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
  }

  handleUpgrade(req, socket, head, callback) {
    callback(socket.ws)
  }
}

function fakeWs() {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.send = vi.fn()
  ws.close = vi.fn()
  return ws
}

function hello() {
  return {
    v:3,
    type:'hello',
    message_id:'msg_01JGATEWAY_HELLO',
    sent_at_utc_msc:NOW,
    session_id:'session_01JGATEWAY01',
    bridge_version:'3.0.0',
    installation_id:'install_0123456789abcdef0123456789abcdef',
    update_report:{
      release_id:'bridge-3.0.0-test', target_version:'3.0.0', state:'healthy',
      started_at_utc_msc:NOW - 5_000, updated_at_utc_msc:NOW,
    },
    terminals:[{
      terminal_instance_id:'terminal_01JGATEWAY1',
      platform:'mt5',
      account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
      connection_epoch:7,
    }],
  }
}

function command() {
  return {
    v:3,
    type:'command',
    message_id:'msg_01JGATEWAY_COMMAND',
    sent_at_utc_msc:NOW,
    command_id:'command_01JGATEWAY01',
    terminal_instance_id:'terminal_01JGATEWAY1',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    issued_at_utc_msc:NOW,
    deadline_utc_msc:NOW + 10_000,
    action:'place_order',
    params:{ symbol:'XAUUSD', volume:'0.01' },
  }
}

function maintenanceRequest(overrides = {}) {
  return {
    actorUserId:42,
    authorizedUserIds:[42],
    installationId:'install_01JGATEWAY01',
    targetVersion:'3.1.0',
    priority:'normal',
    manualRequest:true,
    terminalInstanceIds:['terminal_01JGATEWAY1'],
    expectedDowntimeSeconds:60,
    ...overrides,
  }
}

function result() {
  return {
    v:3,
    type:'command_result',
    message_id:'msg_01JGATEWAY_RESULT',
    sent_at_utc_msc:NOW + 100,
    command_id:'command_01JGATEWAY01',
    terminal_instance_id:'terminal_01JGATEWAY1',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    status:'succeeded',
    completed_at_utc_msc:NOW + 100,
    evidence:{ observed_at_utc_msc:NOW + 100, order_tickets:['1001'] },
  }
}

function quoteRequest(overrides = {}) {
  return {
    v:3,
    type:'quote_request',
    message_id:'msg_01JGATEWAY_QUOTE_REQUEST',
    sent_at_utc_msc:NOW,
    request_id:'quote_01JGATEWAY01',
    terminal_instance_id:'terminal_01JGATEWAY1',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    symbol:'XAUUSD',
    ...overrides,
  }
}

function quote(overrides = {}) {
  return {
    ...quoteRequest(),
    type:'quote',
    message_id:'msg_01JGATEWAY_QUOTE_RESULT',
    sent_at_utc_msc:NOW + 50,
    observed_at_utc_msc:NOW + 50,
    status:'succeeded',
    bid:2345.1,
    ask:2345.3,
    ...overrides,
  }
}

function dataRequest(overrides = {}) {
  return {
    v:3, type:'data_request', message_id:'msg_01JGATEWAY_DATA_REQUEST', sent_at_utc_msc:NOW,
    request_id:'data_01JGATEWAY01', terminal_instance_id:'terminal_01JGATEWAY1',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' }, connection_epoch:7,
    action:'rates', params:{ symbol:'XAUUSD', timeframe:'M30', count:100 }, ...overrides,
  }
}

function dataResponse(overrides = {}) {
  return {
    ...dataRequest(), type:'data_response', message_id:'msg_01JGATEWAY_DATA_RESULT',
    sent_at_utc_msc:NOW + 50, observed_at_utc_msc:NOW + 50,
    status:'succeeded', payload:{ symbol:'XAUUSD', rates:[] }, ...overrides,
  }
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

function setup(overrides = {}) {
  const dependencies = {
    WebSocketServerImpl:FakeWebSocketServer,
    consumeTicket:vi.fn().mockResolvedValue({ userId:42, tokenVersion:3 }),
    queryOneFn:vi.fn().mockResolvedValue({
      id:42, role:'user', token_version:3, has_pro_access:1, trade_send_enabled:1,
    }),
    registerTerminal:vi.fn().mockResolvedValue({ connected:true }),
    disconnectTerminals:vi.fn().mockResolvedValue({ changes:1 }),
    applyDelta:vi.fn().mockResolvedValue({ status:'applied', expected_revision:2 }),
    createLedgerEntry:vi.fn().mockResolvedValue({ command:{ status:'queued' } }),
    markDispatched:vi.fn().mockResolvedValue({ status:'dispatched' }),
    markUncertain:vi.fn().mockResolvedValue({ command:{ status:'uncertain' } }),
    recordResult:vi.fn().mockImplementation(message => Promise.resolve({ command:{ result:message } })),
    countOutstanding:vi.fn().mockResolvedValue(0),
    now:() => NOW,
    ...overrides,
  }
  return { gateway:createBridgeV3Gateway(dependencies), dependencies }
}

async function connect(gateway, { ticket = 'ticket-value' } = {}) {
  const ws = fakeWs()
  const req = { url:`${BRIDGE_V3_WS_PATH}?ticket=${ticket}` }
  gateway.handleUpgrade(req, { ws }, Buffer.alloc(0))
  await flush()
  return ws
}

async function completeInitialSync(ws) {
  for (const [index, stream] of ['account', 'positions', 'orders'].entries()) {
    ws.emit('message', Buffer.from(JSON.stringify({
      ...hello().terminals[0],
      v:3,
      type:'data_delta',
      message_id:`msg_01JGATEWAY_FULL_${stream}`,
      sent_at_utc_msc:NOW,
      stream,
      revision:index + 1,
      base_revision:0,
      observed_at_utc_msc:NOW,
      source_time_msc:NOW,
      full_snapshot:true,
      upserts:stream === 'account' ? [{ login:12345678 }] : [],
      deletes:[],
    })))
    await flush()
  }
}

describe('Bridge v3 websocket gateway', () => {
  it('broadcasts one wake-only release notice to each live connection', async () => {
    const { gateway } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify({
      ...hello(),
      bridge_version:'3.1.2',
    })))
    await flush()

    expect(gateway.broadcastReleaseAvailable({
      releaseId:'bridge-3.1.0-20260728.1',
      releaseVersion:'3.1.0',
      rolloutChannel:'stable',
      reason:'published',
    })).toBe(1)
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      v:3,
      type:'release_available',
      release_id:'bridge-3.1.0-20260728.1',
      release_version:'3.1.0',
      rollout_channel:'stable',
      reason:'published',
    })
  })

  it('keeps legacy v3 clients on polling without sending an unknown notice type', async () => {
    const { gateway } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    const sendsBeforeNotice = ws.send.mock.calls.length

    expect(gateway.broadcastReleaseAvailable({
      releaseId:'bridge-3.1.2-20260728.1',
      releaseVersion:'3.1.2',
    })).toBe(0)
    expect(ws.send.mock.calls).toHaveLength(sendsBeforeNotice)
  })

  it('authenticates with a one-time ticket and requires hello before data', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    expect(dependencies.consumeTicket).toHaveBeenCalledWith('ticket-value')
    expect(dependencies.registerTerminal).toHaveBeenCalledWith(expect.objectContaining({
      userId:42, terminalInstanceId:'terminal_01JGATEWAY1', connectionEpoch:7,
      installationId:'install_0123456789abcdef0123456789abcdef',
      bridgeVersion:'3.0.0', updateReport:expect.objectContaining({ state:'healthy' }),
    }))
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({ type:'hello_ack', session_id:'session_01JGATEWAY01' })
    expect(gateway.connectionsByTerminal.has('terminal_01JGATEWAY1')).toBe(true)
    expect(gateway.listConnectedTerminals(42)[0].connection_generation).toBe(1)
    expect(gateway.listConnectedUsers()).toEqual([expect.objectContaining({ userId:42, generation:1 })])
    expect(gateway.isTradeEnabled(42)).toBe(true)
    expect(gateway.setTradeEnabled(42, false)).toBe(true)
    expect(gateway.isTradeEnabled(42)).toBe(false)
  })

  it('removes stale sessions from routing until a valid heartbeat arrives', async () => {
    let clock = NOW
    const { gateway } = setup({ now:() => clock })
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()

    clock += BRIDGE_V3_CONNECTION_STALE_MS + 1
    expect(gateway.listConnectedTerminals(42)).toEqual([])
    expect(gateway.listConnectedUsers()).toEqual([
      expect.objectContaining({ userId:42, connected:true, alive:false }),
    ])
    expect(gateway.isTradeEnabled(42)).toBe(false)

    ws.emit('message', Buffer.from(JSON.stringify({
      v:3,
      type:'heartbeat',
      message_id:'heartbeat_01JGATEWAY01',
      sent_at_utc_msc:clock,
      session_id:'session_01JGATEWAY01',
      terminals:[{
        terminal_instance_id:'terminal_01JGATEWAY1',
        connection_epoch:7,
        streams:{ account:clock, positions:clock - 10, orders:clock - 20, deals:clock - 30 },
      }],
    })))
    await flush()
    expect(gateway.listConnectedTerminals(42)).toEqual([
      expect.objectContaining({
        last_seen_at_utc_msc:clock,
        stream_observed_at_utc_msc:{
          account:clock, positions:clock - 10, orders:clock - 20, deals:clock - 30,
        },
      }),
    ])
    expect(gateway.listConnectedUsers()).toEqual([
      expect.objectContaining({ userId:42, connected:true, alive:true }),
    ])
  })

  it('rejects heartbeat freshness for an unknown terminal route', async () => {
    const { gateway } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()

    ws.emit('message', Buffer.from(JSON.stringify({
      v:3, type:'heartbeat', message_id:'heartbeat_01JGATEWAY_BAD',
      sent_at_utc_msc:NOW, session_id:'session_01JGATEWAY01',
      terminals:[{
        terminal_instance_id:'terminal_01JUNKNOWN', connection_epoch:7,
        streams:{ account:NOW },
      }],
    })))
    await flush()

    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'error', error_code:'bridge_heartbeat_terminal_route_invalid',
    })
  })

  it('replaces a reconnected websocket and fences messages from the old connection', async () => {
    const { gateway, dependencies } = setup()
    const oldWs = await connect(gateway, { ticket:'old-ticket' })
    oldWs.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()

    const newWs = await connect(gateway, { ticket:'new-ticket' })
    const reconnectedHello = {
      ...hello(),
      message_id:'msg_01JGATEWAY_RECONNECT',
      session_id:'session_01JGATEWAY02',
    }
    newWs.emit('message', Buffer.from(JSON.stringify(reconnectedHello)))
    await flush()

    expect(oldWs.close).toHaveBeenCalledWith(4001, 'bridge_connection_replaced')
    const reconnectDelta = {
      ...hello().terminals[0],
      v:3,
      type:'data_delta',
      message_id:'msg_01JGATEWAY_RECONNECT_DELTA',
      sent_at_utc_msc:NOW,
      stream:'positions',
      revision:1,
      base_revision:0,
      observed_at_utc_msc:NOW,
      source_time_msc:NOW,
      full_snapshot:false,
      upserts:[],
      deletes:[],
    }
    oldWs.emit('message', Buffer.from(JSON.stringify(reconnectDelta)))
    await flush()
    expect(JSON.parse(oldWs.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'error', error_code:'bridge_connection_replaced',
    })
    expect(dependencies.applyDelta).not.toHaveBeenCalled()

    newWs.emit('message', Buffer.from(JSON.stringify(reconnectDelta)))
    await flush()
    expect(dependencies.applyDelta).toHaveBeenCalledOnce()
  })

  it('rejects missing tickets without registering a terminal', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway, { ticket:'' })
    expect(ws.close).toHaveBeenCalledWith(4002, 'bridge_ticket_required')
    expect(dependencies.registerTerminal).not.toHaveBeenCalled()
  })

  it('fails membership closed even when MySQL returns a string zero', async () => {
    const { gateway, dependencies } = setup({
      queryOneFn:vi.fn().mockResolvedValue({ id:42, token_version:3, has_pro_access:'0' }),
    })
    const ws = await connect(gateway)
    expect(ws.close).toHaveBeenCalledWith(4002, 'bridge_membership_required')
    expect(dependencies.registerTerminal).not.toHaveBeenCalled()
  })

  it('rejects an observer terminal whose MT account differs from its configured source account', async () => {
    const { gateway, dependencies } = setup({
      queryOneFn:vi.fn().mockResolvedValue({
        id:42, role:'user', plan_source:'observer_source', token_version:3, has_pro_access:1,
        trade_send_enabled:1, observer_login_account:'860058', observer_broker_server:'Broker-Demo',
      }),
    })
    const ws = await connect(gateway)

    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()

    expect(dependencies.registerTerminal).not.toHaveBeenCalled()
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'error', error_code:'observer_source_account_mismatch',
    })
  })

  it('cleans up a partially registered multi-terminal hello', async () => {
    const registerTerminal = vi.fn()
      .mockResolvedValueOnce({ connected:true })
      .mockRejectedValueOnce(Object.assign(new Error('binding mismatch'), { code:'bridge_terminal_binding_mismatch' }))
    const { gateway, dependencies } = setup({ registerTerminal })
    const ws = await connect(gateway)
    const message = hello()
    message.terminals.push({
      ...message.terminals[0],
      terminal_instance_id:'terminal_01JGATEWAY2',
    })
    ws.emit('message', Buffer.from(JSON.stringify(message)))
    await flush()
    expect(dependencies.disconnectTerminals).toHaveBeenCalledWith(
      message.session_id, 42, expect.objectContaining({ nowUtcMsc:NOW })
    )
    expect(gateway.connectionsByTerminal.size).toBe(0)
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'error', error_code:'bridge_terminal_binding_mismatch',
    })
  })

  it('applies deltas and returns an outbox acknowledgement', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    ws.emit('message', Buffer.from(JSON.stringify({
      ...hello().terminals[0],
      v:3,
      type:'data_delta',
      message_id:'msg_01JGATEWAY_DELTA',
      sent_at_utc_msc:NOW,
      stream:'positions',
      revision:1,
      base_revision:0,
      observed_at_utc_msc:NOW,
      source_time_msc:NOW,
      full_snapshot:false,
      upserts:[{ ticket:'1001' }],
      deletes:[],
    })))
    await flush()
    expect(dependencies.applyDelta).toHaveBeenCalledOnce()
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'data_ack', status:'applied', acked_message_id:'msg_01JGATEWAY_DELTA', expected_revision:2,
    })
  })

  it('canonicalizes legacy queued deltas that omitted a null source time', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    const legacyDelta = {
      ...hello().terminals[0],
      v:3,
      type:'data_delta',
      message_id:'msg_01JGATEWAY_LEGACY_DELTA',
      sent_at_utc_msc:NOW,
      stream:'positions',
      revision:1,
      base_revision:0,
      observed_at_utc_msc:NOW,
      full_snapshot:false,
      upserts:[],
      deletes:[],
    }
    ws.emit('message', Buffer.from(JSON.stringify(legacyDelta)))
    await flush()
    expect(dependencies.applyDelta).toHaveBeenCalledWith(
      expect.objectContaining({ source_time_msc:null }),
      expect.objectContaining({ userId:42 }),
    )
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'data_ack', status:'applied', acked_message_id:'msg_01JGATEWAY_LEGACY_DELTA',
    })
  })

  it('marks a terminal ready only after all three full snapshots are acknowledged', async () => {
    const { gateway } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    expect(gateway.listConnectedTerminals(42)[0].initial_sync_ready).toBe(false)

    await completeInitialSync(ws)

    expect(gateway.listConnectedTerminals(42)[0].initial_sync_ready).toBe(true)
  })

  it('notifies account binding once when initial sync becomes ready and on disconnect', async () => {
    const onTerminalReady = vi.fn().mockResolvedValue(undefined)
    const onTerminalDisconnected = vi.fn().mockResolvedValue(undefined)
    const { gateway } = setup({ onTerminalReady, onTerminalDisconnected })
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()

    await completeInitialSync(ws)

    expect(onTerminalReady).toHaveBeenCalledOnce()
    expect(onTerminalReady).toHaveBeenCalledWith(expect.objectContaining({
      userId:42,
      terminal:expect.objectContaining({ terminal_instance_id:'terminal_01JGATEWAY1' }),
      connectionGeneration:1,
    }))
    ws.emit('close')
    await flush()
    expect(onTerminalDisconnected).toHaveBeenCalledOnce()
  })

  it('keeps independent observer routes online when one source disconnects', async () => {
    const consumeTicket = vi.fn(ticket => Promise.resolve({
      userId:ticket === 'source-a-ticket' ? 42 : 84,
      tokenVersion:3,
    }))
    const queryOneFn = vi.fn((_, params) => Promise.resolve({
      id:Number(params[0]), role:'admin', token_version:3, has_pro_access:1,
      trade_send_enabled:1,
    }))
    const { gateway } = setup({ consumeTicket, queryOneFn })
    const sourceA = await connect(gateway, { ticket:'source-a-ticket' })
    const sourceB = await connect(gateway, { ticket:'source-b-ticket' })
    const helloA = hello()
    const helloB = {
      ...hello(),
      message_id:'msg_01JGATEWAY_HELLO_B',
      session_id:'session_01JGATEWAY02',
      terminals:[{
        ...hello().terminals[0],
        terminal_instance_id:'terminal_01JGATEWAY2',
        platform:'mt4',
        account_ref:{ broker_server:'Observer-B-Demo', login:'840002' },
        connection_epoch:8,
      }],
    }
    sourceA.emit('message', Buffer.from(JSON.stringify(helloA)))
    sourceB.emit('message', Buffer.from(JSON.stringify(helloB)))
    await flush()

    const queryA = {
      ...command(),
      message_id:'msg_01JGATEWAY_QUERY_A',
      command_id:'command_01JGATEWAY_QUERY_A',
      action:'query_execution',
      params:{ expected_kind:'position', ticket:'420001' },
    }
    const queryB = {
      ...queryA,
      message_id:'msg_01JGATEWAY_QUERY_B',
      command_id:'command_01JGATEWAY_QUERY_B',
      terminal_instance_id:helloB.terminals[0].terminal_instance_id,
      account_ref:helloB.terminals[0].account_ref,
      connection_epoch:helloB.terminals[0].connection_epoch,
      params:{ expected_kind:'position', ticket:'840001' },
    }
    const pendingA = gateway.sendCommand(42, queryA)
    const pendingB = gateway.sendCommand(84, queryB)
    await flush()
    expect(JSON.parse(sourceA.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'command', command_id:queryA.command_id, terminal_instance_id:'terminal_01JGATEWAY1',
    })
    expect(JSON.parse(sourceB.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'command', command_id:queryB.command_id, terminal_instance_id:'terminal_01JGATEWAY2',
    })
    sourceA.emit('message', Buffer.from(JSON.stringify({ ...result(), command_id:queryA.command_id })))
    sourceB.emit('message', Buffer.from(JSON.stringify({
      ...result(),
      message_id:'msg_01JGATEWAY_RESULT_B',
      command_id:queryB.command_id,
      terminal_instance_id:queryB.terminal_instance_id,
      account_ref:queryB.account_ref,
      connection_epoch:queryB.connection_epoch,
    })))
    await expect(pendingA).resolves.toMatchObject({ status:'succeeded' })
    await expect(pendingB).resolves.toMatchObject({ status:'succeeded' })

    sourceA.emit('close')
    await flush()

    expect(gateway.listConnectedTerminals(42)).toEqual([])
    expect(gateway.listConnectedTerminals(84)).toEqual([
      expect.objectContaining({ terminal_instance_id:'terminal_01JGATEWAY2', platform:'mt4' }),
    ])
    expect(gateway.connectionsByTerminal.has('terminal_01JGATEWAY1')).toBe(false)
    expect(gateway.connectionsByTerminal.has('terminal_01JGATEWAY2')).toBe(true)
  })

  it('disables trading and closes every connection when account ownership is revoked', async () => {
    const { gateway } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    expect(gateway.isTradeEnabled(42)).toBe(true)

    expect(gateway.disconnectUser(42, 'bridge_account_ownership_transferred')).toBe(1)

    expect(gateway.isTradeEnabled(42)).toBe(false)
    expect(ws.close).toHaveBeenCalledWith(4004, 'bridge_account_ownership_transferred')
  })

  it('keeps commands queued until all initial snapshots are acknowledged', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()

    await expect(gateway.sendCommand(42, command())).resolves.toMatchObject({
      status:'queued', error:'bridge_terminal_initial_sync_pending',
    })
    expect(dependencies.markDispatched).not.toHaveBeenCalled()
    expect(ws.send.mock.calls.map(call => JSON.parse(call[0]).type)).not.toContain('command')
  })

  it('allows execution reconciliation before initial snapshots finish', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    const query = {
      ...command(),
      message_id:'msg_01JGATEWAY_QUERY',
      command_id:'command_01JGATEWAY_QUERY',
      action:'query_execution',
      params:{ expected_kind:'pending', ticket:'1001' },
    }

    const pending = gateway.sendCommand(42, query)
    await flush()
    expect(dependencies.markDispatched).toHaveBeenCalledWith(
      query.command_id, expect.objectContaining({ connectionEpoch:7 })
    )
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'command', action:'query_execution', command_id:query.command_id,
    })
    ws.emit('message', Buffer.from(JSON.stringify({ ...result(), command_id:query.command_id })))
    await expect(pending).resolves.toMatchObject({ status:'succeeded', command_id:query.command_id })
  })

  it('persists dispatch before writing and resolves only after a stored result', async () => {
    const order = []
    const { gateway, dependencies } = setup({
      createLedgerEntry:vi.fn(async () => { order.push('ledger'); return { command:{ status:'queued' } } }),
      markDispatched:vi.fn(async () => { order.push('dispatch'); return { status:'dispatched' } }),
      recordResult:vi.fn(async message => { order.push('result'); return { command:{ result:message } } }),
    })
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    await completeInitialSync(ws)
    ws.send.mockImplementation(payload => {
      if (JSON.parse(payload).type === 'command') order.push('send')
    })

    const pending = gateway.sendCommand(42, command())
    await flush()
    expect(order).toEqual(['ledger', 'dispatch', 'send'])
    ws.emit('message', Buffer.from(JSON.stringify(result())))
    await expect(pending).resolves.toMatchObject({ status:'succeeded', command_id:'command_01JGATEWAY01' })
    expect(order).toEqual(['ledger', 'dispatch', 'send', 'result'])
    expect(dependencies.recordResult).toHaveBeenCalledWith(
      expect.objectContaining({ type:'command_result' }),
      expect.objectContaining({ allowUncertainResolution:true, nowUtcMsc:NOW })
    )
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'command_result_ack',
      acked_message_id:'msg_01JGATEWAY_RESULT',
      command_id:'command_01JGATEWAY01',
      status:'applied',
    })
    expect(dependencies.markUncertain).not.toHaveBeenCalled()
  })

  it('blocks new commands before ledger admission while a maintenance lease is active', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    await completeInitialSync(ws)

    const lease = await gateway.acquireMaintenanceLease(maintenanceRequest())
    expect(lease).toMatchObject({ acquired:true, terminal_instance_ids:['terminal_01JGATEWAY1'] })
    await expect(gateway.sendCommand(42, command())).resolves.toMatchObject({
      status:'rejected', error:'bridge_maintenance', message:'量见智桥正在安全更新，请稍后重试',
    })
    expect(dependencies.createLedgerEntry).not.toHaveBeenCalled()

    expect(gateway.releaseMaintenanceLease(42, lease.lease_id)).toMatchObject({ released:true })
    const pending = gateway.sendCommand(42, command())
    await flush()
    ws.emit('message', Buffer.from(JSON.stringify(result())))
    await expect(pending).resolves.toMatchObject({ status:'succeeded' })
  })

  it.each([1, 5, 20])('isolates a maintenance lease across %i connected terminals', async terminalCount => {
    const { gateway } = setup()
    const ws = await connect(gateway)
    const terminalIds = Array.from(
      { length:terminalCount },
      (_, index) => `terminal_scale_${String(index).padStart(2, '0')}`,
    )
    ws.emit('message', Buffer.from(JSON.stringify({
      ...hello(),
      terminals:terminalIds.map((terminalInstanceId, index) => ({
        terminal_instance_id:terminalInstanceId,
        platform:index % 2 === 0 ? 'mt5' : 'mt4',
        account_ref:{ broker_server:'Broker-Demo', login:String(10_000 + index) },
        connection_epoch:7,
      })),
    })))
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"hello_ack"')))

    const lease = await gateway.acquireMaintenanceLease(maintenanceRequest({
      terminalInstanceIds:terminalIds,
    }))

    expect(lease).toMatchObject({ acquired:true, terminal_instance_ids:terminalIds })
    expect(gateway.maintenanceByTerminal.size).toBe(terminalCount)
    expect(gateway.releaseMaintenanceLease(42, lease.lease_id)).toMatchObject({ released:true })
    expect(gateway.maintenanceByTerminal.size).toBe(0)
  })

  it('denies a lease until both admission races and durable commands are drained', async () => {
    let releaseLedger
    const createLedgerEntry = vi.fn(() => new Promise(resolve => { releaseLedger = resolve }))
    const { gateway, dependencies } = setup({ createLedgerEntry })
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    await completeInitialSync(ws)

    const sending = gateway.sendCommand(42, command())
    await flush()
    await expect(gateway.acquireMaintenanceLease(maintenanceRequest())).resolves.toMatchObject({
      acquired:false, code:'bridge_maintenance_commands_in_flight',
    })
    expect(gateway.maintenanceByTerminal.size).toBe(0)

    releaseLedger({ command:{ status:'queued' } })
    await flush()
    ws.emit('message', Buffer.from(JSON.stringify(result())))
    await expect(sending).resolves.toMatchObject({ status:'succeeded' })

    dependencies.countOutstanding.mockResolvedValueOnce(1)
    await expect(gateway.acquireMaintenanceLease(maintenanceRequest())).resolves.toMatchObject({
      acquired:false, code:'bridge_maintenance_commands_in_flight',
    })
    expect(gateway.maintenanceByTerminal.size).toBe(0)
  })

  it('fails closed when a lease names a terminal outside the authorized users', async () => {
    const { gateway } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()

    await expect(gateway.acquireMaintenanceLease(maintenanceRequest({
      authorizedUserIds:[7],
    }))).rejects.toMatchObject({ code:'bridge_maintenance_request_invalid' })
    await expect(gateway.acquireMaintenanceLease(maintenanceRequest({
      actorUserId:7,
      authorizedUserIds:[7],
    }))).rejects.toMatchObject({ code:'bridge_maintenance_terminal_forbidden' })
  })

  it('returns queued without dispatch when the exact terminal route is offline', async () => {
    const { gateway, dependencies } = setup()
    await expect(gateway.sendCommand(42, command())).resolves.toMatchObject({
      status:'queued', error:'bridge_terminal_not_connected',
    })
    expect(dependencies.markDispatched).not.toHaveBeenCalled()
  })

  it('replays an already persisted final receipt without dispatching again', async () => {
    const stored = result()
    const { gateway, dependencies } = setup({
      createLedgerEntry:vi.fn().mockResolvedValue({
        command:{ status:'succeeded', result:stored },
      }),
    })

    await expect(gateway.sendCommand(42, command())).resolves.toMatchObject({
      status:'succeeded', command_id:'command_01JGATEWAY01', duplicate:true,
    })
    expect(dependencies.markDispatched).not.toHaveBeenCalled()
  })

  it('routes a quote transiently without touching the command ledger', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()

    const pending = gateway.requestQuote(42, quoteRequest())
    await flush()
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'quote_request', request_id:'quote_01JGATEWAY01', symbol:'XAUUSD',
    })
    ws.emit('message', Buffer.from(JSON.stringify(quote({ symbol:'XAUUSD.s' }))))
    await expect(pending).resolves.toMatchObject({ symbol:'XAUUSD.s', bid:2345.1, ask:2345.3 })
    expect(gateway.pendingQuotes.size).toBe(0)
    expect(dependencies.createLedgerEntry).not.toHaveBeenCalled()
  })

  it('routes transient data without touching the command ledger', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    const pending = gateway.requestData(42, dataRequest())
    await flush()
    expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({
      type:'data_request', request_id:'data_01JGATEWAY01', action:'rates',
    })
    ws.emit('message', Buffer.from(JSON.stringify(dataResponse())))
    await expect(pending).resolves.toMatchObject({ status:'succeeded', payload:{ rates:[] } })
    expect(gateway.pendingDataRequests.size).toBe(0)
    expect(dependencies.createLedgerEntry).not.toHaveBeenCalled()
  })

  it('rejects an offline or timed-out transient quote without persisting it', async () => {
    vi.useFakeTimers()
    try {
      const { gateway, dependencies } = setup()
      expect(() => gateway.requestQuote(42, quoteRequest()))
        .toThrowError(expect.objectContaining({ code:'bridge_terminal_not_connected' }))

      const ws = await connect(gateway)
      ws.emit('message', Buffer.from(JSON.stringify(hello())))
      await vi.runAllTimersAsync()
      const pending = gateway.requestQuote(42, quoteRequest(), { timeoutMs:50 })
      const rejected = expect(pending).rejects.toMatchObject({ code:'bridge_quote_timeout' })
      await vi.advanceTimersByTimeAsync(50)
      await rejected
      expect(gateway.pendingQuotes.size).toBe(0)
      expect(dependencies.createLedgerEntry).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears pending transient quotes when the bridge disconnects', async () => {
    const { gateway } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    const pending = gateway.requestQuote(42, quoteRequest())
    const rejected = expect(pending).rejects.toMatchObject({ code:'bridge_quote_disconnected' })
    ws.emit('close')
    await rejected
    expect(gateway.pendingQuotes.size).toBe(0)
  })

  it('marks a dispatched command uncertain on timeout and never retries it', async () => {
    vi.useFakeTimers()
    try {
      const { gateway, dependencies } = setup()
      const ws = await connect(gateway)
      ws.emit('message', Buffer.from(JSON.stringify(hello())))
      await vi.runAllTimersAsync()
      await completeInitialSync(ws)
      const pending = gateway.sendCommand(42, command(), { timeoutMs:50 })
      await vi.advanceTimersByTimeAsync(50)
      await expect(pending).resolves.toMatchObject({ status:'uncertain', command_id:'command_01JGATEWAY01' })
      expect(dependencies.markUncertain).toHaveBeenCalledWith('command_01JGATEWAY01', expect.objectContaining({
        reason:'bridge_result_timeout',
      }))
      expect(ws.send.mock.calls.filter(([payload]) => JSON.parse(payload).type === 'command')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
