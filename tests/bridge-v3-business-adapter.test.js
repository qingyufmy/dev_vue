import { describe, expect, it, vi } from 'vitest'

import { createBridgeV3BusinessAdapter } from '../server/bridge-v3/business-adapter.js'

const NOW = 1_800_000_000_000

function route(overrides = {}) {
  return {
    terminal_instance_id:'terminal_01JBUSINESS01',
    platform:'mt5',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    initial_sync_ready:true,
    ...overrides,
  }
}

function setup({ routes = [route()], account, rows = [], revision, tradeRow, quote, commandResult } = {}) {
  const gateway = {
    listConnectedTerminals:vi.fn().mockReturnValue(routes),
    isTradeEnabled:vi.fn().mockReturnValue(true),
    setTradeEnabled:vi.fn().mockReturnValue(true),
    requestQuote:vi.fn().mockResolvedValue(quote || {
      status:'succeeded', symbol:'XAUUSD', bid:2300, ask:2300.2,
      observed_at_utc_msc:NOW,
    }),
    sendCommand:vi.fn().mockResolvedValue(commandResult || {
      status:'succeeded', command_id:'command_01JBUSINESS01',
      raw_result:{ order:1001, deal:2001, price:2300.2, retcode:10009 },
      evidence:{ observed_at_utc_msc:NOW, order_tickets:['1001'], deal_tickets:['2001'], broker_retcode:10009 },
    }),
  }
  const queryOneFn = vi.fn(async sql => {
    if (sql.includes('bridge_v3_stream_revisions')) {
      return revision === null ? null : revision || { revision:3, observed_at_utc_msc:NOW }
    }
    if (sql.includes('bridge_v3_account_latest')) {
      return account === null ? null : { payload_json:JSON.stringify(account || {
        login:12345678, server:'Broker-Demo', balance:1000, equity:1005,
      }) }
    }
    if (sql.includes('FROM users u LEFT JOIN')) {
      return tradeRow || { role:'user', trade_send_enabled:1 }
    }
    throw new Error(`unexpected_query:${sql}`)
  })
  const queryAllFn = vi.fn().mockResolvedValue(rows.map(item => ({ payload_json:JSON.stringify(item) })))
  return {
    gateway,
    queryOneFn,
    queryAllFn,
    adapter:createBridgeV3BusinessAdapter({ gateway, queryOneFn, queryAllFn, now:() => NOW }),
  }
}

describe('Bridge v3 business compatibility adapter', () => {
  it('serves a fresh account snapshot in the legacy response shape', async () => {
    const { adapter } = setup()

    await expect(adapter.execute(42, 'account')).resolves.toMatchObject({
      status:'success', login:12345678, server:'Broker-Demo', source:'mt5', terminal_connected:true,
    })
  })

  it('normalizes raw MT5 positions and supports a symbol filter', async () => {
    const { adapter } = setup({ rows:[
      { ticket:10, identifier:20, symbol:'XAUUSD', type:0, volume:0.1, price_open:2300, sl:2290, tp:2320 },
      { ticket:11, identifier:21, symbol:'EURUSD', type:1, volume:0.2, price_open:1.1 },
    ] })

    const result = await adapter.execute(42, 'positions', { symbol:'XAUUSD' })

    expect(result).toMatchObject({ status:'success', count:1, source:'mt5' })
    expect(result.positions[0]).toMatchObject({
      ticket:'10', position_id:'20', type:'buy', open_price:2300, sl:2290, tp:2320,
    })
  })

  it('uses stream revision evidence to return a valid empty pending list', async () => {
    const { adapter } = setup({ rows:[] })

    await expect(adapter.execute(42, 'pending_list')).resolves.toEqual({
      status:'success', orders:[], source:'mt5',
    })
  })

  it('fails closed when a read-model stream is stale', async () => {
    const { adapter } = setup({ revision:{ revision:3, observed_at_utc_msc:NOW - 30_001 } })

    await expect(adapter.execute(42, 'positions')).resolves.toMatchObject({
      status:'error', error:'bridge_snapshot_stale',
    })
  })

  it('routes transient quotes without querying the read model', async () => {
    const { adapter, gateway, queryOneFn } = setup()

    const result = await adapter.execute(42, 'quote', { symbol:'XAUUSD' })

    expect(result).toMatchObject({ status:'success', bid:2300, ask:2300.2, source:'mt5' })
    expect(gateway.requestQuote).toHaveBeenCalledWith(42, expect.objectContaining({
      type:'quote_request', symbol:'XAUUSD', terminal_instance_id:'terminal_01JBUSINESS01',
    }), { timeoutMs:5000 })
    expect(queryOneFn).not.toHaveBeenCalled()
  })

  it('maps a legacy market open into a durable v3 command and maps its receipt back', async () => {
    const { adapter, gateway } = setup()

    const result = await adapter.execute(42, 'open', {
      symbol:'XAUUSD', order_type:'buy', volume:0.1, sl:2290, tp:2320,
    })

    expect(gateway.sendCommand).toHaveBeenCalledWith(42, expect.objectContaining({
      type:'command', action:'place_order',
      params:{ symbol:'XAUUSD', side:'buy', order_kind:'market', volume:0.1,
        stop_loss:2290, take_profit:2320 },
    }), { timeoutMs:5000 })
    expect(result).toMatchObject({
      status:'success', ticket:'1001', order:'1001', position_id:'1001', deal:'2001', retcode:10009,
    })
  })

  it('maps stop-limit pending fields without losing expiration semantics', async () => {
    const { adapter, gateway } = setup()

    await adapter.execute(42, 'pending', {
      symbol:'XAUUSD', order_type:'buy_stop_limit', volume:0.1, price:2310,
      stoplimit_price:2308, expiration:1_900_000_000,
    })

    expect(gateway.sendCommand.mock.calls[0][1].params).toMatchObject({
      side:'buy', order_kind:'stop_limit', stop_limit_price:2308,
      expiration:1_900_000_000, type_time:2,
    })
  })

  it('derives a stable command id from the durable order-intent comment', async () => {
    const { adapter, gateway } = setup()
    const params = { symbol:'XAUUSD', order_type:'buy', volume:0.1, comment:'AI-2S' }

    await adapter.execute(42, 'open', params)
    await adapter.execute(42, 'open', params)

    const first = gateway.sendCommand.mock.calls[0][1].command_id
    const second = gateway.sendCommand.mock.calls[1][1].command_id
    expect(first).toBe(second)
    expect(first).toMatch(/^command_[a-f0-9]{64}$/)
  })

  it('blocks v3 trades from the server-side setting before creating a ledger command', async () => {
    const { adapter, gateway } = setup({ tradeRow:{ role:'user', trade_send_enabled:0 } })

    await expect(adapter.execute(42, 'close', { ticket:'10' })).resolves.toMatchObject({
      status:'error', error:'bridge_trade_disabled',
    })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
  })

  it('does not admit trades until all initial snapshots are acknowledged', async () => {
    const { adapter, gateway } = setup({ routes:[route({ initial_sync_ready:false })] })

    await expect(adapter.execute(42, 'open', {
      symbol:'XAUUSD', order_type:'buy', volume:0.1,
    })).resolves.toMatchObject({ status:'error', error:'bridge_terminal_initializing' })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
  })

  it('applies the local trade switch without sending a terminal trade command', async () => {
    const { adapter, gateway } = setup()

    await expect(adapter.execute(42, 'toggle_trade', { enable:false })).resolves.toEqual({
      status:'success', live_trading_enabled:false,
    })
    expect(gateway.setTradeEnabled).toHaveBeenCalledWith(42, false)
    expect(gateway.sendCommand).not.toHaveBeenCalled()
  })

  it('requires an explicit route when one user has multiple connected terminals', async () => {
    const routes = [route(), route({
      terminal_instance_id:'terminal_01JBUSINESS02',
      account_ref:{ broker_server:'Other-Demo', login:'999' },
    })]
    const { adapter } = setup({ routes })

    await expect(adapter.execute(42, 'account')).resolves.toMatchObject({
      status:'error', error:'bridge_terminal_ambiguous',
    })
    await expect(adapter.execute(42, 'account', { terminal_instance_id:'terminal_01JBUSINESS02' }))
      .resolves.toMatchObject({ status:'success' })
  })
})
