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
    expect(validateBridgeV3Message(hello)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...hello, terminals:[hello.terminals[0], hello.terminals[0]] }))
      .toMatchObject({ ok:false, errors:expect.arrayContaining(['terminals.1.terminal_instance_id:duplicate']) })
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

  it('validates routed transient quote requests and broker observations', () => {
    const request = envelope('quote_request', {
      ...route(),
      request_id:'quote_01JBRIDGE0001',
      symbol:'XAUUSD',
    })
    expect(validateBridgeV3Message(request)).toEqual({ ok:true, errors:[] })

    const quote = {
      ...request,
      type:'quote',
      observed_at_utc_msc:NOW,
      bid:2345.1,
      ask:2345.3,
      last:2345.2,
    }
    expect(validateBridgeV3Message(quote)).toEqual({ ok:true, errors:[] })
    expect(validateBridgeV3Message({ ...quote, ask:2345.0 })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['ask:below_bid']),
    })
    expect(validateBridgeV3Message({ ...quote, symbol:' ' })).toMatchObject({
      ok:false,
      errors:expect.arrayContaining(['symbol:invalid']),
    })
  })

  it('enforces contiguous stream revisions so gaps trigger a full snapshot', () => {
    const delta = envelope('data_delta', {
      ...route(),
      stream:'positions',
      revision:12,
      base_revision:11,
      observed_at_utc_msc:NOW,
      source_time_msc:NOW - 20,
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
