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
  revision, tradeRow, quote, dataResponse, commandResult, nowValue = NOW } = {}) {
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
        trade_allowed:true, trade_expert:true,
        terminal_trade_allowed:true, program_trade_allowed:true,
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
    adapter:createBridgeV3BusinessAdapter({ gateway, queryOneFn, queryAllFn, now:() => nowValue }),
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

  it('normalizes MT4 open time and current price for the shared positions UI', async () => {
    const { adapter } = setup({
      routes:[route({ platform:'mt4' })],
      rows:[{
        ticket:'307526062', symbol:'XAUUSD.s', type:0, volume:0.01,
        price_open:4091.74, price_current:4095.31, open_time:1785152761,
      }],
    })

    const result = await adapter.execute(42, 'positions')

    expect(result.positions[0]).toMatchObject({
      ticket:'307526062', source:'mt4', price_current:4095.31,
      time:1785152761, open_time:1785152761,
    })
  })

  it('uses stream revision evidence to return a valid empty pending list', async () => {
    const { adapter } = setup({ rows:[] })

    await expect(adapter.execute(42, 'pending_list')).resolves.toEqual({
      status:'success', orders:[], source:'mt5',
    })
  })

  it('normalizes MT4 pending timestamps exposed by the EA snapshot', async () => {
    const { adapter } = setup({
      routes:[route({ platform:'mt4' })],
      rows:[{
        ticket:'103287473', symbol:'XAUUSD', type:2, volume:0.01, price_open:4000,
        open_time:1_800_000_000, expiration:1_800_014_400,
      }],
    })

    const result = await adapter.execute(42, 'pending_list')

    expect(result.orders[0]).toMatchObject({
      ticket:'103287473', pending_type:'buy_limit',
      created_at:'2027-01-15 08:00:00', valid_until:'2027-01-15 12:00:00',
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
    const { adapter, gateway, queryOneFn } = setup({ quote:{
      status:'succeeded', symbol:'XAUUSD', bid:2300, ask:2300.2,
      observed_at_utc_msc:NOW, timezone_offset_minutes:180, clock_status:'broker_time_derived',
    } })

    const result = await adapter.execute(42, 'quote', { symbol:'XAUUSD' })

    expect(result).toMatchObject({
      status:'success', bid:2300, ask:2300.2, source:'mt5',
      timezone_offset_minutes:180, clock_status:'broker_time_derived',
    })
    expect(gateway.requestQuote).toHaveBeenCalledWith(42, expect.objectContaining({
      type:'quote_request', symbol:'XAUUSD', terminal_instance_id:'terminal_01JBUSINESS01',
    }), { timeoutMs:5000 })
    expect(queryOneFn).not.toHaveBeenCalled()
  })

  it('does not coerce missing terminal clock metadata to UTC', async () => {
    const { adapter } = setup({ quote:{
      status:'succeeded', symbol:'XAUUSD', bid:2300, ask:2300.2,
      observed_at_utc_msc:NOW, timezone_offset_minutes:null,
    } })

    const result = await adapter.execute(42, 'quote', { symbol:'XAUUSD' })

    expect(result.timezone_offset_minutes).toBeNull()
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

  it('fails closed during history maintenance without dispatching any history read', async () => {
    const previous = process.env.BRIDGE_HISTORY_READS_ENABLED
    process.env.BRIDGE_HISTORY_READS_ENABLED = 'false'
    try {
      const { adapter, gateway } = setup()
      for (const action of [
        'history', 'history_page', 'history_evidence', 'chart_data',
        'history_chart_data', 'export_history', 'history_prepare_status_v1',
      ]) {
        await expect(adapter.execute(42, action, {
          page:1, page_size:20,
          range_start_utc_msc:NOW - 86_400_000,
          range_end_utc_msc:NOW,
          history_snapshot_id:'a'.repeat(64),
          cursor:'b'.repeat(64),
          evidence_position_ids:['1001'],
        })).resolves.toMatchObject({
          status:'error', code:'bridge_history_temporarily_unavailable',
          error:'bridge_history_temporarily_unavailable',
        })
      }
      expect(gateway.requestData).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.BRIDGE_HISTORY_READS_ENABLED
      else process.env.BRIDGE_HISTORY_READS_ENABLED = previous
    }
  })

  it('preserves a strict exact millisecond history range through the data adapter', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ orders:[], pagination:{ total_count:0 }, source:'mt5' },
    } })
    const rangeStart = NOW - 86_400_000
    await expect(adapter.execute(42, 'history', {
      page:1, page_size:20,
      range_start_utc_msc:rangeStart,
      range_end_utc_msc:NOW,
    }, { timeoutMs:30_000 })).resolves.toMatchObject({ status:'success', orders:[] })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'history', params:expect.objectContaining({
        range_start_utc_msc:rangeStart, range_end_utc_msc:NOW,
      }),
    }), { timeoutMs:30_000 })

    gateway.requestData.mockClear()
    await expect(adapter.execute(42, 'history', {
      page:1, page_size:20, date_from:'2026-01-01',
      range_start_utc_msc:rangeStart, range_end_utc_msc:NOW,
    })).resolves.toMatchObject({ status:'error', error:'history_range_invalid' })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('routes lightweight history preparation with only frozen range evidence', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{
        history_sync:{ requested_range_complete:false, backfill_pending:true }, source:'mt5_sqlite',
      },
    } })
    const rangeStart = NOW - 86_400_000
    const effectiveEnd = NOW - 3_600_000
    await expect(adapter.execute(42, 'history_prepare_status_v1', {
      range_start_utc_msc:rangeStart,
      range_end_utc_msc:effectiveEnd,
      allowed_start_utc_msc:rangeStart,
      system_start_utc_msc:rangeStart,
      effective_start_utc_msc:rangeStart,
      captured_end_utc_msc:NOW,
      page:9, page_size:200, direction:'SELL', profit_filter:'loss', force_refresh:true,
    }, { timeoutMs:30_000 })).resolves.toMatchObject({
      status:'success', history_sync:{ requested_range_complete:false, backfill_pending:true },
    })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'history_prepare_status_v1',
      params:{
        range_start_utc_msc:rangeStart,
        range_end_utc_msc:effectiveEnd,
        allowed_start_utc_msc:rangeStart,
        system_start_utc_msc:rangeStart,
        effective_start_utc_msc:rangeStart,
        captured_end_utc_msc:NOW,
      },
    }), { timeoutMs:30_000 })

    gateway.requestData.mockClear()
    await expect(adapter.execute(42, 'history_prepare_status_v1', {
      range_start_utc_msc:rangeStart,
    })).resolves.toMatchObject({ status:'error', error:'history_range_invalid' })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('forwards close-time filters and frozen range evidence before pagination', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ orders:[], pagination:{ total_count:0 }, source:'mt5' },
    } })
    const rangeStart = NOW - 86_400_000
    await expect(adapter.execute(42, 'history_page', {
      page_size:20, range_start_utc_msc:rangeStart, range_end_utc_msc:NOW,
      allowed_start_utc_msc:NOW - 30 * 86_400_000,
      system_start_utc_msc:rangeStart,
      effective_start_utc_msc:rangeStart,
      captured_end_utc_msc:NOW,
      filter_close_from:'2026-01-01', filter_close_to:'2026-01-02',
      history_snapshot_id:'a'.repeat(64), cursor:'b'.repeat(64),
    })).resolves.toMatchObject({ status:'success' })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'history_page', params:expect.objectContaining({
        range_start_utc_msc:rangeStart, range_end_utc_msc:NOW,
        allowed_start_utc_msc:NOW - 30 * 86_400_000,
        system_start_utc_msc:rangeStart, effective_start_utc_msc:rangeStart,
        captured_end_utc_msc:NOW,
        filter_close_from:'2026-01-01', filter_close_to:'2026-01-02',
      }),
    }), { timeoutMs:5_000 })

    const legacy = setup({ routes:[route({ history_close_filter_supported:false })] })
    await expect(legacy.adapter.execute(42, 'history', {
      page:1, page_size:20, range_start_utc_msc:rangeStart, range_end_utc_msc:NOW,
      filter_close_from:'2026-01-01',
    })).resolves.toMatchObject({ status:'error', error:'bridge_history_close_filter_unsupported' })
    expect(legacy.gateway.requestData).not.toHaveBeenCalled()
  })

  it('accepts numeric terminal-time filter bounds after server business-day resolution', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ orders:[], pagination:{ total_count:0 }, source:'mt5' },
    } })
    const rangeStart = NOW - 86_400_000
    await expect(adapter.execute(42, 'history_page', {
      page_size:1, range_start_utc_msc:rangeStart, range_end_utc_msc:NOW,
      filter_close_from:rangeStart + 3_600_000,
      filter_close_to:NOW - 1,
      entry_from:rangeStart + 1_000,
      entry_to:NOW - 1,
    })).resolves.toMatchObject({ status:'success' })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'history_page', params:expect.objectContaining({
        filter_close_from:rangeStart + 3_600_000,
        filter_close_to:NOW - 1,
        entry_from:rangeStart + 1_000,
        entry_to:NOW - 1,
      }),
    }), { timeoutMs:5_000 })
  })

  it('forwards bounded position and order references for open-position history evidence', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ orders:[], deals:[], history_orders:[], source:'mt5' },
    } })

    await expect(adapter.execute(42, 'history', {
      page:1, page_size:20, include_deals:true,
      evidence_position_ids:['694675577'], evidence_order_tickets:['694675577'],
    }, { timeoutMs:30_000 })).resolves.toMatchObject({ status:'success', deals:[] })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      type:'data_request', action:'history', params:expect.objectContaining({
        include_deals:true,
        evidence_position_ids:['694675577'],
        evidence_order_tickets:['694675577'],
      }),
    }), { timeoutMs:30_000 })

    await expect(adapter.execute(42, 'history', {
      page:1, page_size:20, include_deals:true, evidence_position_ids:['invalid'],
    })).resolves.toMatchObject({ status:'error', error:'history_params_invalid' })
  })

  it('routes exact indexed history evidence without ordinary page parameters', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ deals:[], history_orders:[], source:'mt5' },
    } })
    const rangeStart = NOW - 86_400_000
    await expect(adapter.execute(42, 'history_evidence', {
      range_start_utc_msc:rangeStart,
      range_end_utc_msc:NOW,
      evidence_position_ids:['694675577'],
      evidence_order_tickets:['694675578'],
    }, { timeoutMs:30_000 })).resolves.toMatchObject({ status:'success', deals:[] })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'history_evidence',
      params:{
        range_start_utc_msc:rangeStart,
        range_end_utc_msc:NOW,
        evidence_position_ids:['694675577'],
        evidence_order_tickets:['694675578'],
      },
    }), { timeoutMs:30_000 })

    gateway.requestData.mockClear()
    await expect(adapter.execute(42, 'history_evidence', {
      range_start_utc_msc:rangeStart,
      range_end_utc_msc:NOW,
    })).resolves.toMatchObject({ status:'error', error:'history_params_invalid' })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('routes opaque history cursors only with an exact range and bound snapshot', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ orders:[], history_snapshot_id:'a'.repeat(64),
        next_cursor:'b'.repeat(64), has_more:true, source:'mt5_sqlite' },
    } })
    const rangeStart = NOW - 86_400_000
    await expect(adapter.execute(42, 'history_page', {
      page_size:20,
      range_start_utc_msc:rangeStart,
      range_end_utc_msc:NOW,
      history_snapshot_id:'a'.repeat(64),
      cursor:'b'.repeat(64),
      direction:'BUY',
    })).resolves.toMatchObject({ status:'success', has_more:true })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'history_page',
      params:expect.objectContaining({
        page_size:20,
        range_start_utc_msc:rangeStart,
        range_end_utc_msc:NOW,
        snapshot_id:'a'.repeat(64),
        cursor:'b'.repeat(64),
        direction:'BUY',
      }),
    }), { timeoutMs:5_000 })

    gateway.requestData.mockClear()
    await expect(adapter.execute(42, 'history_page', {
      page_size:20, range_start_utc_msc:rangeStart, range_end_utc_msc:NOW,
      cursor:'b'.repeat(64),
    })).resolves.toMatchObject({ status:'error', error:'history_cursor_invalid' })
    await expect(adapter.execute(42, 'history_page', {
      page_size:20, range_start_utc_msc:rangeStart,
    })).resolves.toMatchObject({ status:'error', error:'history_range_invalid' })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('rejects oversized history pages so evidence stays within the bridge frame budget', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ orders:[], deals:[], history_orders:[], source:'mt5' },
    } })

    await expect(adapter.execute(42, 'history', {
      page:1, page_size:5000, include_deals:true, date_from:'2026-01-01',
    }, { timeoutMs:30_000 })).resolves.toMatchObject({
      status:'error', error:'history_pagination_invalid',
    })
    await expect(adapter.execute(42, 'history', {
      page:501, page_size:20, date_from:'2026-01-01',
    }, { timeoutMs:30_000 })).resolves.toMatchObject({
      status:'error', error:'history_pagination_invalid',
    })
    expect(gateway.requestData).not.toHaveBeenCalled()
  })

  it('routes pending terminal-state reconciliation and diagnostics through v3', async () => {
    const { adapter, gateway } = setup({ dataResponse:{
      status:'succeeded', payload:{ current_state:'history', final_state:'cancelled', source:'mt5' },
    } })
    const expectedState = {
      ticket:'5001', symbol:'XAUUSD', direction:'buy', volume:0.1, magic:234000,
      margin_mode:'hedging', internal_only:'server-audit-only',
    }

    await expect(adapter.execute(42, 'pending_order_state', {
      ticket:'5001', expected_state:expectedState,
    })).resolves.toMatchObject({ status:'success', final_state:'cancelled' })
    expect(gateway.requestData).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'pending_order_state', params:{
        ticket:'5001', expected_state:{
          ticket:'5001', symbol:'XAUUSD', direction:'buy', volume:0.1, magic:234000,
        },
      },
    }), { timeoutMs:5000 })

    gateway.requestData.mockResolvedValueOnce({
      status:'succeeded', payload:{ mt5_connected:true, terminal:{ connected:true }, source:'mt5' },
    })
    await expect(adapter.execute(42, 'diagnostics')).resolves.toMatchObject({
      status:'success', mt5_connected:true,
    })
    expect(gateway.requestData).toHaveBeenLastCalledWith(42, expect.objectContaining({
      action:'diagnostics', params:{},
    }), { timeoutMs:5000 })

    await expect(adapter.execute(42, 'status')).resolves.toMatchObject({
      mode:'live', mt5_package_available:true, live_trading_enabled:true,
      terminal_trade_allowed:true, account_trade_allowed:true,
      account_trade_expert:true, program_trade_allowed:true,
      login:12345678, server:'Broker-Demo', balance:1000, equity:1005,
    })
    expect(gateway.requestData).toHaveBeenCalledTimes(2)
  })

  it('keeps MT4 terminal, program, account and server EA permissions independent', async () => {
    const { adapter } = setup({
      routes:[route({ platform:'mt4' })],
      account:{
        login:'8950701', server:'DPrimeVU-Demo 5', balance:9999.73, equity:10000,
        trade_allowed:true, trade_expert:false,
        terminal_trade_allowed:true, program_trade_allowed:true,
      },
    })

    await expect(adapter.execute(42, 'status')).resolves.toMatchObject({
      source:'mt4', terminal_trade_allowed:true, program_trade_allowed:true,
      account_trade_allowed:true, account_trade_expert:false,
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
      status:'succeeded', raw_result:{ found:false, complete:true, lookback_seconds:2_592_000 },
    } })
    await expect(adapter.execute(42, 'order_lookup', {
      expected_kind:'pending', pending_ticket:'5003', lookback_seconds:2_592_000,
    })).resolves.toMatchObject({ status:'success', found:false, complete:true })
    expect(gateway.sendCommand).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'query_execution', params:{ expected_kind:'pending', pending_ticket:'5003', lookback_seconds:2_592_000 },
    }), { timeoutMs:5000 })
  })

  it('rejects an order reconciliation lookback beyond the 30-day safety window', async () => {
    const { adapter, gateway } = setup()
    await expect(adapter.execute(42, 'order_lookup', {
      expected_kind:'trade', trade_ticket:'999', lookback_seconds:2_592_001,
    })).resolves.toMatchObject({ status:'error', error:'order_lookup_params_invalid' })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
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

  it('returns display-ready market metadata with a direct quote', async () => {
    const { adapter } = setup({ quote:{
      status:'succeeded', symbol:'XAUUSD.s', bid:4053.38, ask:4053.56,
      observed_at_utc_msc:NOW - 500, symbol_trade_mode:4, terminal_connected:true,
    } })

    const result = await adapter.execute(42, 'quote', { symbol:'XAUUSD' })
    expect(result).toMatchObject({
      status:'success', symbol:'XAUUSD.s',
      market_state_version:1, market_state:'open', market_reason:'quote_fresh',
      symbol_trade_mode:4, tick_age_seconds:0.5,
    })
    expect(result.spread).toBeCloseTo(0.18, 8)
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

  it('reports a stale weekend quote as a closed market', async () => {
    const sunday = Date.UTC(2026, 6, 26, 3, 0, 0)
    const { adapter } = setup({ nowValue:sunday, quote:{
      status:'succeeded', symbol:'XAUUSD', bid:4053.38, ask:4053.56,
      observed_at_utc_msc:Date.UTC(2026, 6, 24, 23, 54, 59),
      symbol_trade_mode:4, terminal_connected:true, timezone_offset_minutes:180,
      clock_status:'provisional_stale',
    } })

    await expect(adapter.execute(42, 'market_state', { symbol:'XAUUSD' })).resolves.toMatchObject({
      status:'success', market_state:'closed', market_reason:'weekend_tick_stale',
      symbol_trade_mode:4, tick_progressing:false, clock_status:'provisional_stale',
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

  it('never aliases a pending order ticket as a position id', async () => {
    const { adapter } = setup({ commandResult:{
      status:'succeeded', command_id:'command_pending_01',
      raw_result:{ order:3001, retcode:10008 },
      evidence:{ observed_at_utc_msc:NOW, order_tickets:['3001'], broker_retcode:10008 },
    } })

    const result = await adapter.execute(42, 'pending', {
      symbol:'XAUUSD', order_type:'sell_limit', volume:0.1, price:2310,
    })

    expect(result).toMatchObject({ status:'success', ticket:'3001', order:'3001', retcode:10008 })
    expect(result).not.toHaveProperty('position_id')
  })

  it('maps manual close and pending cancellation to their exact durable actions', async () => {
    const { adapter, gateway } = setup()

    await adapter.execute(42, 'close', { ticket:'1001', volume:0.05 })
    await adapter.execute(42, 'cancel_pending', { ticket:'2001' })

    expect(gateway.sendCommand.mock.calls[0][1]).toMatchObject({
      action:'close_position', params:{ ticket:'1001', volume:0.05 },
    })
    expect(gateway.sendCommand.mock.calls[1][1]).toMatchObject({
      action:'cancel_order', params:{ ticket:'2001' },
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

  it('rejects stop-limit before command dispatch when the selected terminal is MT4', async () => {
    const { adapter, gateway } = setup({ routes:[route({ platform:'mt4' })] })

    const result = await adapter.execute(42, 'pending', {
      symbol:'XAUUSD', order_type:'buy_stop_limit', volume:0.1, price:2310,
      stoplimit_price:2308,
    })

    expect(result).toMatchObject({ status:'error', error:'mt4_stop_limit_unsupported' })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
  })

  it('reports platform order capabilities with bridge status', async () => {
    const { adapter } = setup({ routes:[route({ platform:'mt4' })] })

    await expect(adapter.execute(42, 'status')).resolves.toMatchObject({
      source:'mt4', capabilities:{ stop_limit_orders:false },
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
    expect(gateway.sendCommand.mock.calls[0][1].params.comment).toBe('AI-2S')
    expect(gateway.sendCommand.mock.calls[1][1].params.comment).toBe('AI-2S')
  })

  it('preserves the durable order-intent comment for pending-order reconciliation', async () => {
    const { adapter, gateway } = setup()

    await adapter.execute(42, 'pending', {
      symbol:'XAUUSD', order_type:'buy_limit', volume:0.1, price:2300, comment:'AI-PENDING-7',
    })

    expect(gateway.sendCommand.mock.calls[0][1].params).toMatchObject({
      side:'buy', order_kind:'limit', comment:'AI-PENDING-7',
    })
  })

  it('rejects comments that the terminal cannot preserve for reconciliation', async () => {
    const { adapter, gateway } = setup()

    await expect(adapter.execute(42, 'open', {
      symbol:'XAUUSD', order_type:'buy', volume:0.1, comment:'x'.repeat(32),
    })).resolves.toMatchObject({ status:'error', error:'order_comment_invalid' })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
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

  it('maps an unchanged system pending order to a guarded cancellation command', async () => {
    const order = {
      ticket:20, symbol:'XAUUSD', side:'buy', type:2,
      volume_current:0.1, volume_initial:0.1, magic:234000,
    }
    const expectedState = {
      ticket:'20', symbol:'XAUUSD', direction:'buy', magic:234000, volume:0.1,
    }
    const { adapter, gateway } = setup({ orderRows:[order] })

    await expect(adapter.execute(42, 'cancel_system_pending', {
      ticket:'20', operation_id:'cancel-pending-20', expected_state:expectedState,
    })).resolves.toMatchObject({ status:'success' })

    expect(gateway.sendCommand).toHaveBeenCalledWith(42, expect.objectContaining({
      action:'cancel_order',
      params:{
        ticket:'20', symbol:'XAUUSD', side:'buy', volume:0.1, magic:234000,
        expected_state:expectedState,
      },
    }), { timeoutMs:5000 })
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

  it('projects complete management state onto the strict Worker whitelist', async () => {
    const { adapter, gateway } = setup({
      positionRows:[{
        ticket:10, symbol:'XAUUSD', type:0, volume:0.1, magic:234000, sl:2290, tp:2320,
      }],
      orderRows:[{
        ticket:20, symbol:'XAUUSD', side:'buy', type:2,
        volume_current:0.1, volume_initial:0.1, magic:234000,
      }],
    })
    const positionState = {
      broker_server_key:'Broker-Demo', login_account:'12345678',
      ticket:'10', symbol:'XAUUSD', direction:'buy', magic:234000, volume:0.1,
      stop_loss:2290, take_profit:2320,
      margin_mode:'hedging', internal_only:'server-audit-only',
    }
    const pendingState = {
      ...positionState, ticket:'20', margin_mode:'netting', internal_only:'audit-only',
    }
    const wirePositionState = {
      broker_server_key:'Broker-Demo', login_account:'12345678',
      ticket:'10', symbol:'XAUUSD', direction:'buy', magic:234000, volume:0.1,
      stop_loss:2290, take_profit:2320,
    }
    const wirePendingState = { ...wirePositionState, ticket:'20' }

    await expect(adapter.execute(42, 'close_system_position', {
      ticket:'10', expected_state:positionState,
    })).resolves.toMatchObject({ status:'success' })
    await expect(adapter.execute(42, 'cancel_system_pending', {
      ticket:'20', expected_state:pendingState,
    })).resolves.toMatchObject({ status:'success' })
    await expect(adapter.execute(42, 'modify_system_position_protection', {
      ticket:'10', stop_loss:2295, expected_state:positionState,
    })).resolves.toMatchObject({ status:'success' })

    expect(gateway.sendCommand.mock.calls[0][1].params.expected_state).toEqual(wirePositionState)
    expect(gateway.sendCommand.mock.calls[1][1].params.expected_state).toEqual(wirePendingState)
    expect(gateway.sendCommand.mock.calls[2][1].params.expected_state).toEqual(wirePositionState)
    for (const [, command] of gateway.sendCommand.mock.calls) {
      expect(command.params.expected_state).not.toHaveProperty('margin_mode')
      expect(command.params.expected_state).not.toHaveProperty('internal_only')
    }
    expect(positionState).toMatchObject({ margin_mode:'hedging', internal_only:'server-audit-only' })
    expect(pendingState).toMatchObject({ margin_mode:'netting', internal_only:'audit-only' })
  })

  it('keeps legacy close and cancel commands compatible with a server-only expected state', async () => {
    const { adapter, gateway } = setup()
    const expectedState = {
      ticket:'10', symbol:'XAUUSD', direction:'buy', magic:7, volume:0.1,
      margin_mode:'hedging', internal_only:'server-audit-only',
    }
    const cancelExpectedState = { ...expectedState, ticket:'20' }

    await expect(adapter.execute(42, 'close', {
      ticket:'10', expected_state:expectedState,
    })).resolves.toMatchObject({ status:'success' })
    await expect(adapter.execute(42, 'cancel_pending', {
      ticket:'20', expected_state:cancelExpectedState,
    })).resolves.toMatchObject({ status:'success' })

    expect(gateway.sendCommand).toHaveBeenNthCalledWith(1, 42, expect.objectContaining({
      action:'close_position',
      params:expect.objectContaining({
        ticket:'10', expected_state:{
          ticket:'10', symbol:'XAUUSD', direction:'buy', magic:7, volume:0.1,
        },
      }),
    }), { timeoutMs:5000 })
    expect(gateway.sendCommand).toHaveBeenNthCalledWith(2, 42, expect.objectContaining({
      action:'cancel_order',
      params:expect.objectContaining({
        ticket:'20', expected_state:{
          ticket:'20', symbol:'XAUUSD', direction:'buy', magic:7, volume:0.1,
        },
      }),
    }), { timeoutMs:5000 })
  })

  it('fails closed before writing when required management state is missing or invalid', async () => {
    const { adapter, gateway } = setup({ positionRows:[{
      ticket:10, symbol:'XAUUSD', type:0, volume:0.1, magic:234000,
    }] })

    await expect(adapter.execute(42, 'close_system_position', {
      ticket:'10', expected_state:{
        ticket:'10', direction:'buy', magic:234000, volume:0.1,
      },
    })).resolves.toMatchObject({ status:'rejected', error:'management_expected_symbol_required' })
    await expect(adapter.execute(42, 'modify_system_position_protection', {
      ticket:'10', stop_loss:2295, expected_state:{
        ticket:'10', symbol:'XAUUSD', direction:'long', magic:234000, volume:0.1,
      },
    })).resolves.toMatchObject({ status:'rejected', error:'management_expected_direction_invalid' })
    await expect(adapter.execute(42, 'cancel_system_pending', {
      ticket:'10', expected_state:{
        ticket:'10', symbol:'XAUUSD', direction:'buy', magic:'not-an-integer', volume:0.1,
      },
    })).resolves.toMatchObject({ status:'rejected', error:'management_expected_state_invalid' })
    expect(gateway.sendCommand).not.toHaveBeenCalled()
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
