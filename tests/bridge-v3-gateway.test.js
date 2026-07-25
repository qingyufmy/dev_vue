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
  it('authenticates with a one-time ticket and requires hello before data', async () => {
    const { gateway, dependencies } = setup()
    const ws = await connect(gateway)
    ws.emit('message', Buffer.from(JSON.stringify(hello())))
    await flush()
    expect(dependencies.consumeTicket).toHaveBeenCalledWith('ticket-value')
    expect(dependencies.registerTerminal).toHaveBeenCalledWith(expect.objectContaining({
      userId:42, terminalInstanceId:'terminal_01JGATEWAY1', connectionEpoch:7,
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
    })))
    await flush()
    expect(gateway.listConnectedTerminals(42)).toHaveLength(1)
    expect(gateway.listConnectedUsers()).toEqual([
      expect.objectContaining({ userId:42, connected:true, alive:true }),
    ])
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
    ws.emit('message', Buffer.from(JSON.stringify(quote())))
    await expect(pending).resolves.toMatchObject({ bid:2345.1, ask:2345.3 })
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
