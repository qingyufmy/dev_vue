import { describe, expect, it, vi } from 'vitest'

import { createBridgeV3BusinessAdapter } from '../server/bridge-v3/business-adapter.js'

const NOW = 1_800_000_000_000

function route(overrides = {}) {
  return {
    terminal_instance_id:'terminal_01JBUSINESS01',
    platform:'mt5',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    connection_generation:11,
    initial_sync_ready:true,
    ...overrides,
  }
}

function setup({ routes = [route()], account, rows = [], positionRows, orderRows,
  revision, tradeRow, quote, dataResponse, commandResult } = {}) {
  const gateway = {
    listConnectedTerminals:vi.fn().mockReturnValue(routes),
    isTradeEnabled:vi.fn().mockReturnValue(true),
    setTradeEnabled:vi.fn().mockReturnValue(true),
    requestQuote:vi.fn().mockResolvedValue(quote || {
      status:'succeeded', symbol:'XAUUSD', bid:2300, ask:2300.2,
      observed_at_utc_msc:NOW,
    }),
    requestData:vi.fn().mockResolvedValue(dataResponse || {
      status:'succeeded', payload:{ symbol:'XAUUSD', timeframe:'M30', count:1,
        rates:[{ time_utc_msc:NOW, open:2300, high:2301, low:2299, close:2300.5 }] },
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
  const queryAllFn = vi.fn(async sql => {
    const selected = sql.includes('bridge_v3_positions_latest') ? positionRows ?? rows : orderRows ?? rows
    return selected.map(item => ({ payload_json:JSON.stringify(item) }))
  })
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

  it('keeps an unchanged read-model stream fresh from terminal heartbeat evidence', async () => {
    const { adapter } = setup({
      routes:[route({ stream_observed_at_utc_msc:{ positions:NOW - 100 } })],
      revision:{ revision:3, observed_at_utc_msc:NOW - 30_001 },
    })

    await expect(adapter.execute(42, 'positions')).resolves.toMatchObject({
      status:'success', positions:[], source:'mt5',
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

  it('routes bounded rates through the transient data channel', async () => {
    const { adapter, gateway, queryOneFn } = setup()
    const result = await adapter.execute(42, 'rates', {
      symbol:'XAUUSD', timeframe:'m30', count:100,
    }, { timeoutMs:15_000 })
    expect(result).toMatchObject({ status:'success', symbol:'XAUUSD', source:'mt5' })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      type:'data_request', action:'rates',
      params:{ symbol:'XAUUSD', timeframe:'M30', count:100 },
    }), { timeoutMs:15_000 })
    expect(queryOneFn).not.toHaveBeenCalled()
  })

  it('routes symbols and legacy history views through the transient data channel', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ orders:[], pagination:{ total_count:0 }, source:'mt5' },
    } })

    await expect(adapter.execute(42, 'history', {
      page:1, page_size:20, date_from:'2026-01-01', date_to:'2026-01-31',
    }, { timeoutMs:30_000 })).resolves.toMatchObject({ status:'success', orders:[] })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      type:'data_request', action:'history', params:{
        page:1, page_size:20, date_from:'2026-01-01', date_to:'2026-01-31',
      },
    }), { timeoutMs:30_000 })

    gateway.requestData.mockResolvedValueOnce({
      status:'succeeded', payload:{ symbols:[{ name:'XAUUSD.s' }], source:'mt5' },
    })
    await expect(adapter.execute(42, 'symbols')).resolves.toMatchObject({
      status:'success', symbols:[{ name:'XAUUSD.s' }],
    })
  })

  it('rejects invalid rates bounds before contacting the terminal', async () => {
    const { adapter, gateway } = setup()
    await expect(adapter.execute(42, 'rates', {
      symbol:'XAUUSD', timeframe:'S1', count:10_000,
    })).resolves.toMatchObject({ status:'error', error:'rates_timeframe_invalid' })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('rejects rates without a symbol before contacting the terminal', async () => {
    const { adapter, gateway } = setup()
    await expect(adapter.execute(42, 'rates', { timeframe:'M30', count:100 }))
      .resolves.toMatchObject({ status:'error', error:'symbol_invalid' })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('routes a lightweight symbol snapshot over the transient data channel', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ symbol:'XAUUSD', account:{ leverage:100 },
        instrument:{ tick_size:0.01, contract_size:100 } },
    } })
    await expect(adapter.execute(42, 'symbol_snapshot', { symbol:'XAUUSD' }))
      .resolves.toMatchObject({ status:'success', source:'mt5',
        instrument:{ tick_size:0.01, contract_size:100 } })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'symbol_snapshot', params:{ symbol:'XAUUSD' },
    }), { timeoutMs:5000 })
  })

  it('normalizes and routes an incremental risk snapshot without the command ledger', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ snapshot_version:1, complete:true,
        increment:{ through_cursor:{ time_msc:123, ticket:9 } }, positions:[], pending:[] },
    } })
    await expect(adapter.execute(42, 'risk_snapshot', {
      symbol:'XAUUSD', last_deal_time_msc:100, last_deal_ticket:8,
      baseline_from_utc_msc:0,
      proposed_order:{ symbol:'XAUUSD', order_type:'buy_limit', volume:'0.1', entry_price:'2300', sl:'2290' },
    }, { timeoutMs:10_000 })).resolves.toMatchObject({
      status:'success', snapshot_version:1, complete:true, source:'mt5',
    })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'risk_snapshot', params:{ symbol:'XAUUSD', last_deal_time_msc:100,
        last_deal_ticket:8, baseline_from_utc_msc:0,
        proposed_order:{ symbol:'XAUUSD', order_type:'buy_limit', volume:0.1, entry_price:2300, sl:2290 } },
    }), { timeoutMs:10_000 })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
  })

  it('rejects malformed risk snapshot cursors before terminal I/O', async () => {
    const { adapter, gateway } = setup()
    await expect(adapter.execute(42, 'risk_snapshot', {
      symbol:'XAUUSD', last_deal_time_msc:-1,
    })).resolves.toMatchObject({ status:'error', error:'risk_snapshot_cursor_invalid' })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('routes a bounded daily performance query without exporting unbounded history', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ performance_version:1, date_from:'2026-01-01',
        date_to:'2026-01-31', timezone_offset_minutes:0, daily:[], scanned_deal_count:0 },
    } })
    await expect(adapter.execute(42, 'performance_daily', {
      date_from:'2026-01-01', date_to:'2026-01-31',
    }, { timeoutMs:30_000 })).resolves.toMatchObject({
      status:'success', performance_version:1, source:'mt5', daily:[],
    })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'performance_daily', params:{ date_from:'2026-01-01', date_to:'2026-01-31' },
    }), { timeoutMs:30_000 })
  })

  it('rejects an oversized performance range before terminal I/O', async () => {
    const { adapter, gateway } = setup()
    await expect(adapter.execute(42, 'performance_daily', {
      date_from:'2026-01-01', date_to:'2026-02-01',
    })).resolves.toMatchObject({ status:'error', error:'performance_date_range_too_large' })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('maps order reconciliation to a durable query_execution command', async () => {
    const { adapter, gateway } = setup({ commandResult:{
      status:'succeeded', command_id:'command_01JLOOKUP01',
      raw_result:{ found:true, kind:'trade', ticket:501, position_id:501,
        symbol:'XAUUSD', lookback_seconds:3600 },
      evidence:{ observed_at_utc_msc:NOW, position_tickets:['501'] },
    } })
    await expect(adapter.execute(42, 'order_lookup', {
      symbol:'XAUUSD', expected_kind:'trade', bridge_command_ref:'intent:abc',
      trade_ticket:'999', lookback_seconds:3600,
    })).resolves.toMatchObject({
      status:'success', found:true, kind:'trade', position_id:501,
    })
    expect(gateway.sendCommand).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'query_execution', params:{ symbol:'XAUUSD', expected_kind:'trade',
        bridge_command_ref:'intent:abc', trade_ticket:'999', lookback_seconds:3600 },
    }), { timeoutMs:5000 })
  })

  it('allows ticket-only order reconciliation without a symbol', async () => {
    const { adapter, gateway } = setup({ commandResult:{
      status:'succeeded', raw_result:{ found:false, complete:true, lookback_seconds:315_360_000 },
    } })
    await expect(adapter.execute(42, 'order_lookup', {
      expected_kind:'pending', pending_ticket:'5003', lookback_seconds:315_360_000,
    })).resolves.toMatchObject({ status:'success', found:false, complete:true })
    expect(gateway.sendCommand).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'query_execution', params:{ expected_kind:'pending', pending_ticket:'5003', lookback_seconds:315_360_000 },
    }), { timeoutMs:5000 })
  })

  it('derives a versioned market state from a fresh transient quote', async () => {
    const { adapter } = setup({ quote:{
      status:'succeeded', symbol:'XAUUSD', bid:2300, ask:2300.2,
      observed_at_utc_msc:NOW - 500, symbol_trade_mode:4, terminal_connected:true,
    } })

    await expect(adapter.execute(42, 'market_state', { symbol:'XAUUSD' })).resolves.toMatchObject({
      status:'success', market_state_version:1, market_state:'open',
      market_reason:'quote_fresh', symbol_trade_mode:4,
      terminal_connected:true, tick_progressing:true, tick_age_seconds:0.5,
    })
  })

  it('fails market state closed when the last quote is stale', async () => {
    const { adapter } = setup({ quote:{
      status:'succeeded', symbol:'XAUUSD', bid:2300, ask:2300.2,
      observed_at_utc_msc:NOW - 120_001, symbol_trade_mode:4, terminal_connected:true,
    } })

    await expect(adapter.execute(42, 'market_state', { symbol:'XAUUSD' })).resolves.toMatchObject({
      status:'success', market_state:'stale', market_reason:'tick_stale', tick_progressing:false,
    })
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

  it('preserves generation and durable before-write guards for v3 trades', async () => {
    const beforeWrite = vi.fn().mockResolvedValue(true)
    const { adapter, gateway } = setup()

    await expect(adapter.execute(42, 'close', { ticket:'1001', operation_id:'op-guard' }, {
      expectedGeneration:11,
      beforeWrite,
    })).resolves.toMatchObject({ status:'success' })
    expect(beforeWrite).toHaveBeenCalledWith(expect.objectContaining({
      bridgeGeneration:11,
      userId:42,
      action:'close',
    }))
    expect(gateway.sendCommand).toHaveBeenCalledOnce()

    await expect(adapter.execute(42, 'close', { ticket:'1002' }, {
      expectedGeneration:10,
      beforeWrite,
    })).resolves.toMatchObject({ status:'error', error:'Bridge generation changed before command write' })
    expect(gateway.sendCommand).toHaveBeenCalledOnce()

    await expect(adapter.execute(42, 'close', { ticket:'1003' }, {
      expectedGeneration:11,
      beforeWrite:vi.fn().mockResolvedValue(false),
    })).resolves.toMatchObject({ status:'error', error:'Bridge command write blocked' })
    await expect(adapter.execute(42, 'close', { ticket:'1004' }, {
      expectedGeneration:11,
      beforeWrite:vi.fn().mockRejectedValue(new Error('ledger unavailable')),
    })).resolves.toMatchObject({
      status:'error',
      error:'Bridge command write blocked: ledger unavailable',
    })
    expect(gateway.sendCommand).toHaveBeenCalledOnce()
  })

  it('serves a fresh system-only inventory for MT5 and derives hedging mode', async () => {
    const { adapter } = setup({
      account:{ login:12345678, server:'Broker-Demo', margin_mode:2 },
      positionRows:[
        { ticket:10, symbol:'XAUUSD', type:0, volume:0.1, magic:234000 },
        { ticket:11, symbol:'EURUSD', type:1, volume:0.2, magic:7 },
      ],
      orderRows:[
        { ticket:20, symbol:'XAUUSD', type:2, volume_current:0.1, magic:234000 },
        { ticket:21, symbol:'EURUSD', type:3, volume_current:0.2, magic:7 },
      ],
    })

    await expect(adapter.execute(42, 'system_trade_inventory')).resolves.toMatchObject({
      status:'success', magic:234000, source:'mt5',
      account:{ login:'12345678', server:'Broker-Demo', margin_mode:2, is_hedging:true },
      positions:[{ ticket:'10', type:'buy', magic:234000 }],
      pending_orders:[{ ticket:'20', side:'buy', pending_type:'buy_limit', magic:234000 }],
    })
  })

  it('reports MT4 inventory as hedging without inventing an MT5 margin mode', async () => {
    const { adapter } = setup({
      routes:[route({ platform:'mt4' })],
      account:{ login:'12345678', server:'Broker-Demo' },
    })

    await expect(adapter.execute(42, 'system_trade_inventory')).resolves.toMatchObject({
      status:'success', source:'mt4', account:{ margin_mode:-1, is_hedging:true },
    })
  })

  it('validates a system position snapshot before mapping the close command', async () => {
    const beforeWrite = vi.fn().mockResolvedValue(true)
    const { adapter, gateway } = setup({ positionRows:[{
      ticket:10, symbol:'XAUUSD', type:0, volume:0.1, magic:234000,
    }] })
    const expectedState = {
      broker_server_key:'BROKER-DEMO', login_account:'12345678', ticket:'10',
      symbol:'XAUUSD', direction:'buy', magic:234000, volume:0.1,
    }

    await expect(adapter.execute(42, 'close_system_position', {
      ticket:'10', operation_id:'close-op-1', expected_state:expectedState,
    }, { expectedGeneration:11, beforeWrite })).resolves.toMatchObject({ status:'success' })
    expect(gateway.sendCommand).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'close_position',
      params:{ ticket:'10', volume:0.1, magic:234000, symbol:'XAUUSD', side:'buy',
        expected_state:expectedState },
    }), { timeoutMs:5000 })
  })

  it('fails closed on changed system identity and treats an absent target as success', async () => {
    const { adapter, gateway } = setup({ orderRows:[{
      ticket:20, symbol:'XAUUSD', side:'buy', type:2, volume_current:0.1, magic:7,
    }] })
    const expectedState = {
      ticket:'20', symbol:'XAUUSD', direction:'buy', magic:234000, volume:0.1,
    }

    await expect(adapter.execute(42, 'cancel_system_pending', {
      ticket:'20', expected_state:expectedState,
    })).resolves.toMatchObject({ status:'rejected', error:'management_magic_mismatch' })
    await expect(adapter.execute(42, 'cancel_system_pending', {
      ticket:'99', expected_state:{ ...expectedState, ticket:'99' },
    })).resolves.toEqual({ status:'success', ticket:'99', already_absent:true })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
  })

  it('maps guarded system protection changes to the dedicated position action', async () => {
    const { adapter, gateway } = setup({ positionRows:[{
      ticket:10, symbol:'XAUUSD', type:0, volume:0.1, magic:234000, sl:2290, tp:2320,
    }] })
    const expectedState = {
      ticket:'10', symbol:'XAUUSD', direction:'buy', magic:234000, volume:0.1,
      stop_loss:2290, take_profit:2320,
    }

    const result = await adapter.execute(42, 'modify_system_position_protection', {
      ticket:'10', operation_id:'protect-op-1', stop_loss:2295, take_profit:null,
      expected_state:expectedState,
    })

    expect(result).toMatchObject({ status:'success', stop_loss:2295, take_profit:2320 })
    expect(gateway.sendCommand).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'modify_position',
      params:{
        ticket:'10', symbol:'XAUUSD', side:'buy', volume:0.1, magic:234000,
        stop_loss:2295, take_profit:null, expected_stop_loss:2290,
        expected_take_profit:2320, expected_state:expectedState,
      },
    }), { timeoutMs:5000 })
  })

  it('rejects a protection update when the current stop loss changed', async () => {
    const { adapter, gateway } = setup({ positionRows:[{
      ticket:10, symbol:'XAUUSD', type:0, volume:0.1, magic:234000, sl:2291, tp:2320,
    }] })

    await expect(adapter.execute(42, 'modify_system_position_protection', {
      ticket:'10', stop_loss:2295,
      expected_state:{
        ticket:'10', symbol:'XAUUSD', direction:'buy', magic:234000, volume:0.1,
        stop_loss:2290, take_profit:2320,
      },
    })).resolves.toMatchObject({ status:'rejected', error:'position_stop_loss_changed' })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
  })

  it('rejects protection updates when the system position no longer exists', async () => {
    const { adapter, gateway } = setup({ positionRows:[] })

    await expect(adapter.execute(42, 'modify_system_position_protection', {
      ticket:'10', stop_loss:2295,
      expected_state:{
        ticket:'10', symbol:'XAUUSD', direction:'buy', magic:234000, volume:0.1,
        stop_loss:2290, take_profit:2320,
      },
    })).resolves.toMatchObject({ status:'rejected', error:'system_position_not_found' })
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
