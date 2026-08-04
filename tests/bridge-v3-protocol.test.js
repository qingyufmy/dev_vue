import { describe, expect, it } from 'vitest'

import {
  assertBridgeV3Message,
  BRIDGE_PROTOCOL_VERSION,
  sameBridgeRoute,
  validateBridgeV3Message,
} from '../server/bridge-v3/protocol.js'

const NOW = 1_800_000_000_000

function envelope(type, overrides = {}) {
  return {
    v:BRIDGE_PROTOCOL_VERSION,
    type,
    message_id:'msg_01JBRIDGE0001',
    sent_at_utc_msc:NOW,
    ...overrides,
  }
}

function route(overrides = {}) {
  return {
    terminal_instance_id:'terminal_01JBRIDGE0001',
    account_ref:{ broker_server:'Broker-Demo', login:'12345678' },
    connection_epoch:7,
    ...overrides,
  }
}

describe('Bridge v3 protocol contract', () => {
  it('accepts one hello containing unique MT4 and MT5 terminal routes', () => {
    const hello = envelope('hello', {
      session_id:'session_01JBRIDGE01',
      bridge_version:'3.0.0',
      terminals:[
        { ...route(), platform:'mt5' },
        { ...route({ terminal_instance_id:'terminal_01JBRIDGE0002' }), platform:'mt4' },
      ],
    })
    expect(validateBridgeV3Message(hello, { nowUtcMsc:NOW })).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...hello, terminals:[hello.terminals[0], hello.terminals[0]] }))
      .toMatchObject({ ok:false, errors:expect.arrayContaining(['terminals.1.terminal_instance_id:duplicate']) })
  })

  it('validates heartbeat session freshness routes and bounded streams', () => {
    const heartbeat = envelope('heartbeat', {
      session_id:'session_01JBRIDGE03',
      terminals:[{
        terminal_instance_id:'terminal_01JBRIDGE0001',
        connection_epoch:7,
        streams:{ account:NOW, positions:NOW + 1, orders:NOW + 2, deals:NOW + 3 },
      }],
    })
    expect(validateBridgeV3Message(heartbeat)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...heartbeat, session_id:undefined })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['session_id:invalid_id']),
    })
    expect(validateBridgeV3Message({ ...heartbeat, terminals:[] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['terminals:invalid']),
    })
    expect(validateBridgeV3Message({
      ...heartbeat,
      terminals:Array.from({ length:33 }, (_, index) => ({
        ...heartbeat.terminals[0], terminal_instance_id:`terminal_01JBRIDGE${String(index).padStart(4, '0')}`,
      })),
    })).toMatchObject({ ok:false, errors:expect.arrayContaining(['terminals:invalid']) })
    expect(validateBridgeV3Message({
      ...heartbeat,
      terminals:[heartbeat.terminals[0], heartbeat.terminals[0]],
    })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['terminals.1.terminal_instance_id:duplicate']),
    })
    expect(validateBridgeV3Message({
      ...heartbeat,
      terminals:[{ ...heartbeat.terminals[0], connection_epoch:0 }],
    })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['terminals.0.connection_epoch:invalid']),
    })
    expect(validateBridgeV3Message({
      ...heartbeat,
      terminals:[{ ...heartbeat.terminals[0], streams:{ ...heartbeat.terminals[0].streams, symbols:NOW } }],
    })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['terminals.0.streams.symbols:unsupported']),
    })
    expect(validateBridgeV3Message({
      ...heartbeat,
      terminals:[{ ...heartbeat.terminals[0], streams:{ account:0 } }],
    })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['terminals.0.streams.account:invalid']),
    })
    expect(validateBridgeV3Message({
      ...heartbeat,
      terminals:[{ ...heartbeat.terminals[0], streams:{ account:Number.MAX_SAFE_INTEGER + 1 } }],
    })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['terminals.0.streams.account:invalid']),
    })
    expect(validateBridgeV3Message({
      ...heartbeat,
      terminals:[{ ...heartbeat.terminals[0], streams:null }],
    })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['terminals.0.streams:required_object']),
    })
  })

  it('accepts bounded installation update telemetry and rejects unsafe reports', () => {
    const hello = envelope('hello', {
      session_id:'session_01JBRIDGE02',
      bridge_version:'3.1.0',
      installation_id:'install_0123456789abcdef0123456789abcdef',
      update_report:{
        release_id:'bridge-3.1.0-20260728.1', target_version:'3.1.0', state:'healthy',
        started_at_utc_msc:NOW - 60_000, updated_at_utc_msc:NOW,
      },
      terminals:[{ ...route(), platform:'mt5' }],
    })
    expect(validateBridgeV3Message(hello, { nowUtcMsc:NOW })).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({
      ...hello, installation_id:undefined,
    })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['update_report:installation_required']),
    })
    expect(validateBridgeV3Message({
      ...hello, update_report:{ ...hello.update_report, state:'failed', error_code:null },
    })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['update_report.error_code:required']),
    })
    expect(validateBridgeV3Message({
      ...hello,
      update_report:{ ...hello.update_report, updated_at_utc_msc:NOW + 10 * 60 * 1000 + 1 },
    }, { nowUtcMsc:NOW })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['update_report.updated_at_utc_msc:future']),
    })
  })

  it('accepts a routed, unexpired command', () => {
    const command = envelope('command', {
      ...route(),
      command_id:'command_01JBRIDGE0001',
      issued_at_utc_msc:NOW - 100,
      deadline_utc_msc:NOW + 5_000,
      action:'place_order',
      params:{ symbol:'XAUUSD', volume:'0.01', side:'buy' },
    })

    expect(validateBridgeV3Message(command, { nowUtcMsc:NOW })).toEqual({ ok:true, errors:[] })
    expect(assertBridgeV3Message(command, { nowUtcMsc:NOW })).toBe(command)
  })

  it('fails closed for expired, cross-protocol or malformed commands', () => {
    const command = envelope('command', {
      ...route(),
      command_id:'command_01JBRIDGE0002',
      issued_at_utc_msc:NOW - 10_000,
      deadline_utc_msc:NOW - 1,
      action:'place_order',
      params:{},
    })
    expect(validateBridgeV3Message(command, { nowUtcMsc:NOW })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['deadline_utc_msc:expired']),
    })
    expect(validateBridgeV3Message({ ...command, v:2 }, { nowUtcMsc:NOW })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['v:unsupported']),
    })
    expect(() => assertBridgeV3Message({ ...command, params:null }, { nowUtcMsc:NOW }))
      .toThrow('bridge_v3_message_invalid')
  })

  it('requires evidence for every terminal result, including uncertain results', () => {
    const result = envelope('command_result', {
      ...route(),
      command_id:'command_01JBRIDGE0003',
      status:'uncertain',
      completed_at_utc_msc:NOW,
      evidence:{ observed_at_utc_msc:NOW, order_tickets:[], deal_tickets:[] },
    })
    expect(validateBridgeV3Message(result)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...result, evidence:null })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['evidence:required_object']),
    })
  })

  it('accepts only routed command result acknowledgements', () => {
    const acknowledgement = envelope('command_result_ack', {
      ...route(),
      acked_message_id:'result_01JBRIDGE0001',
      command_id:'command_01JBRIDGE0003',
      status:'applied',
    })
    expect(validateBridgeV3Message(acknowledgement)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...acknowledgement, status:'gap' })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['status:unsupported']),
    })
  })

  it('validates routed transient quote requests and broker observations', () => {
    const request = envelope('quote_request', {
      ...route(),
      request_id:'quote_01JBRIDGE0001',
      symbol:'XAUUSD',
    })
    expect(validateBridgeV3Message(request)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({
      ...request, action:'symbol_snapshot', params:{ symbol:'XAUUSD' },
    })).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({
      ...request, action:'risk_snapshot', params:{ symbol:'XAUUSD', last_deal_time_msc:0 },
    })).toEqual({ ok:true, errors:[] })

    const quote = {
      ...request,
      type:'quote',
      observed_at_utc_msc:NOW,
      status:'succeeded',
      bid:2345.1,
      ask:2345.3,
      last:2345.2,
    }
    expect(validateBridgeV3Message(quote)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({
      ...quote, timezone_offset_minutes:-840, clock_status:'c'.repeat(64),
    })).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({
      ...quote, timezone_offset_minutes:840, clock_status:null,
    })).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...quote, timezone_offset_minutes:-841 })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['timezone_offset_minutes:invalid']),
    })
    expect(validateBridgeV3Message({ ...quote, timezone_offset_minutes:841 })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['timezone_offset_minutes:invalid']),
    })
    expect(validateBridgeV3Message({ ...quote, timezone_offset_minutes:1.5 })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['timezone_offset_minutes:invalid']),
    })
    expect(validateBridgeV3Message({ ...quote, clock_status:'' })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['clock_status:invalid']),
    })
    expect(validateBridgeV3Message({ ...quote, clock_status:'c'.repeat(65) })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['clock_status:invalid']),
    })
    expect(validateBridgeV3Message({ ...quote, error_code:'not_allowed' })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['error_code:forbidden']),
    })
    expect(validateBridgeV3Message({ ...quote, status:'rejected', bid:undefined, ask:undefined,
      error_code:'e'.repeat(129) })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['error_code:invalid']),
    })
    expect(validateBridgeV3Message({ ...quote, ask:2345.0 })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['ask:below_bid']),
    })
    expect(validateBridgeV3Message({ ...quote, symbol:' ' })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['symbol:invalid']),
    })
    expect(validateBridgeV3Message({
      ...quote, status:'rejected', bid:undefined, ask:undefined, last:undefined,
      error_code:'symbol_tick_unavailable',
    })).toEqual({ ok:true, errors:[] })
  })

  it('validates a bounded transient data request and its response envelope', () => {
    const request = envelope('data_request', {
      ...route(), request_id:'data_01JBRIDGE0001', action:'rates',
      params:{ symbol:'XAUUSD', timeframe:'M30', count:100 },
    })
    expect(validateBridgeV3Message(request)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({
      ...request, action:'performance_daily', params:{ date_from:'2026-01-01', date_to:'2026-01-31' },
    })).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...request, action:'shell' })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['action:unsupported']),
    })
    expect(validateBridgeV3Message({
      ...request, type:'data_response', observed_at_utc_msc:NOW,
      status:'succeeded', payload:{ rates:[] },
    })).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({
      ...request, type:'data_response', observed_at_utc_msc:NOW, status:'rejected',
    })).toMatchObject({ ok:false, errors:expect.arrayContaining(['error_code:invalid']) })
  })

  it('enforces contiguous stream revisions so gaps trigger a full snapshot', () => {
    const delta = envelope('data_delta', {
      ...route(),
      stream:'positions',
      revision:12,
      base_revision:11,
      observed_at_utc_msc:NOW,
      source_time_msc:NOW - 20,
      full_snapshot:false,
      upserts:[{ ticket:'1001', symbol:'XAUUSD' }],
      deletes:[],
    })
    expect(validateBridgeV3Message(delta)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...delta, revision:13 })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['revision:not_next']),
    })
    expect(validateBridgeV3Message({ ...delta, revision:20, base_revision:0, full_snapshot:true }))
      .toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...delta, revision:20, base_revision:11, full_snapshot:true }))
      .toMatchObject({ ok:false, errors:expect.arrayContaining(['base_revision:full_snapshot_requires_zero']) })
  })

  it('bounds data delta batches and enforces account route identity', () => {
    const delta = envelope('data_delta', {
      ...route(),
      stream:'positions',
      revision:12,
      base_revision:11,
      observed_at_utc_msc:NOW,
      source_time_msc:NOW - 20,
      full_snapshot:false,
      upserts:[{ ticket:'1001' }],
      deletes:['1002', 1003],
    })
    expect(validateBridgeV3Message(delta)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...delta, full_snapshot:'false' })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['full_snapshot:invalid']),
    })
    expect(validateBridgeV3Message({ ...delta, upserts:[null] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['upserts.0:required_object']),
    })
    expect(validateBridgeV3Message({ ...delta, upserts:Array.from({ length:10001 }, () => ({})) })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['upserts:too_many']),
    })
    expect(validateBridgeV3Message({ ...delta, deletes:Array.from({ length:10001 }, () => 'ticket') })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['deletes:too_many']),
    })
    expect(validateBridgeV3Message({ ...delta, deletes:['', -1, 1.5, Number.MAX_SAFE_INTEGER + 1] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['deletes.0:invalid', 'deletes.1:invalid',
        'deletes.2:invalid', 'deletes.3:invalid']),
    })
    expect(validateBridgeV3Message({ ...delta, full_snapshot:true, base_revision:0, deletes:['1002'] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['deletes:full_snapshot_requires_empty']),
    })

    const accountDelta = {
      ...delta,
      stream:'account',
      revision:1,
      base_revision:0,
      full_snapshot:true,
      upserts:[{ login:'12345678', server:'Broker-Demo', balance:1000 }],
      deletes:[],
    }
    expect(validateBridgeV3Message(accountDelta)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...accountDelta, upserts:[{ login:12345678, server:'Broker-Demo' }] }))
      .toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...accountDelta, upserts:[] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['account:invalid']),
    })
    expect(validateBridgeV3Message({ ...accountDelta, upserts:[{ login:'99999999', server:'Broker-Demo' }] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['account:route_mismatch']),
    })
    expect(validateBridgeV3Message({ ...accountDelta, upserts:[{ login:'12345678', server:'Other-Broker' }] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['account:route_mismatch']),
    })
    expect(validateBridgeV3Message({ ...accountDelta, upserts:[{ login:'12345678' }] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['account:route_mismatch']),
    })
  })

  it('validates bounded command result errors, raw payload and execution evidence', () => {
    const result = envelope('command_result', {
      ...route(),
      command_id:'command_01JBRIDGE0004',
      status:'failed',
      completed_at_utc_msc:NOW,
      error_code:'broker_error_1',
      error_message:'x'.repeat(1000),
      raw_result:{ retcode:10009 },
      evidence:{
        observed_at_utc_msc:NOW,
        order_tickets:Array.from({ length:100 }, (_, index) => String(index + 1)),
        position_tickets:['2001'],
        deal_tickets:['3001'],
        broker_retcode:10009,
      },
    })
    expect(validateBridgeV3Message(result)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...result, raw_result:null, evidence:{
      ...result.evidence, broker_retcode:null,
    } })).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...result, error_code:'bad-code' })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['error_code:invalid']),
    })
    expect(validateBridgeV3Message({ ...result, error_code:'e'.repeat(129) })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['error_code:invalid']),
    })
    expect(validateBridgeV3Message({ ...result, error_message:'x'.repeat(1001) })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['error_message:invalid']),
    })
    expect(validateBridgeV3Message({ ...result, error_message:42 })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['error_message:invalid']),
    })
    expect(validateBridgeV3Message({ ...result, raw_result:[] })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['raw_result:invalid']),
    })
    expect(validateBridgeV3Message({ ...result, evidence:{
      ...result.evidence, order_tickets:Array.from({ length:101 }, () => '1'),
    } })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['evidence.order_tickets:too_many']),
    })
    expect(validateBridgeV3Message({ ...result, evidence:{
      ...result.evidence, position_tickets:['', 'p'.repeat(65), 100],
    } })).toMatchObject({
      ok:false, errors:expect.arrayContaining([
        'evidence.position_tickets.0:invalid', 'evidence.position_tickets.1:invalid',
        'evidence.position_tickets.2:invalid',
      ]),
    })
    expect(validateBridgeV3Message({ ...result, evidence:{
      ...result.evidence, deal_tickets:null,
    } })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['evidence.deal_tickets:required_array']),
    })
    expect(validateBridgeV3Message({ ...result, evidence:{
      ...result.evidence, broker_retcode:Number.MAX_SAFE_INTEGER + 1,
    } })).toMatchObject({
      ok:false, errors:expect.arrayContaining(['evidence.broker_retcode:invalid']),
    })
  })

  it('validates the wake-only release notification contract', () => {
    const notification = envelope('release_available', {
      release_id:'bridge-3.1.2-20260728.1',
      release_version:'3.1.2',
      rollout_channel:'stable',
      reason:'published',
    })
    expect(validateBridgeV3Message(notification)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...notification, release_version:'latest' })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['release_version:invalid']),
    })
    expect(validateBridgeV3Message({ ...notification, rollout_channel:'all' })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['rollout_channel:unsupported']),
    })
  })

  it('compares the complete immutable route and normalizes broker case only', () => {
    const expected = route()
    expect(sameBridgeRoute(expected, route({
      account_ref:{ broker_server:'broker-demo', login:'12345678' },
    }))).toBe(true)
    expect(sameBridgeRoute(expected, route({ connection_epoch:8 }))).toBe(false)
    expect(sameBridgeRoute(expected, route({ account_ref:{ broker_server:'Broker-Demo', login:'999' } }))).toBe(false)
    expect(sameBridgeRoute(expected, route({ terminal_instance_id:'terminal_01JBRIDGE9999' }))).toBe(false)
  })
})
