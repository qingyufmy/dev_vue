import { describe, expect, it } from 'vitest'
import { projectionProvesCommandResult } from '../src/modules/execution/index.js'
import type { BridgeExactTradeState } from '../src/modules/trading/index.js'

const position: BridgeExactTradeState = {
  ticket: '1001', symbol: 'XAUUSD', direction: 'buy', order_type: 'market', magic: 7, volume: '0.10', open_price: '3540.20',
  stop_limit_price: null, stop_loss: '3530.00', take_profit: '3560.00', expiration_utc_msc: null,
}

describe('Stage 12G trusted projection absorption', () => {
  it('absorbs a placed order only when an exact terminal result ticket exists in the trusted snapshot', () => {
    const states = new Map([[position.ticket, position]])
    expect(projectionProvesCommandResult({ action: 'order.place', entityKind: 'position', params: {}, result: { position_ticket: '1001' }, states })).toBe(true)
    expect(projectionProvesCommandResult({ action: 'order.place', entityKind: 'position', params: {}, result: { order_ticket: '9999' }, states })).toBe(false)
    expect(projectionProvesCommandResult({ action: 'order.place', entityKind: 'position', params: {}, result: null, states })).toBe(false)
  })

  it('uses a full-snapshot absence as proof for close/cancel but not for modification', () => {
    expect(projectionProvesCommandResult({ action: 'position.close', entityKind: 'position', params: { ticket: '1001' }, result: {}, states: new Map() })).toBe(true)
    expect(projectionProvesCommandResult({ action: 'pending_order.cancel', entityKind: 'pending_order', params: { ticket: '2001' }, result: {}, states: new Map() })).toBe(true)
    expect(projectionProvesCommandResult({ action: 'position.protection.set', entityKind: 'position', params: { ticket: '1001', stop_loss: '3531.00' }, result: {}, states: new Map() })).toBe(false)
  })

  it('requires a partial close to reduce the exact position volume by the requested amount', () => {
    const reduced = { ...position, volume: '0.06' }
    expect(projectionProvesCommandResult({
      action: 'position.close', entityKind: 'position', params: { ticket: '1001', volume: '0.04' },
      expectedState: position, result: {}, states: new Map([[position.ticket, reduced]]),
    })).toBe(true)
    expect(projectionProvesCommandResult({
      action: 'position.close', entityKind: 'position', params: { ticket: '1001', volume: '0.04' },
      expectedState: position, result: {}, states: new Map([[position.ticket, { ...reduced, volume: '0.07' }]]),
    })).toBe(false)
    expect(projectionProvesCommandResult({
      action: 'position.close', entityKind: 'position', params: { ticket: '1001', volume: '0.10' },
      expectedState: position, result: {}, states: new Map(),
    })).toBe(true)
  })

  it('requires the projected protection values to match every requested field', () => {
    const states = new Map([[position.ticket, position]])
    expect(projectionProvesCommandResult({ action: 'position.protection.set', entityKind: 'position', params: { ticket: '1001', stop_loss: '3530.00', take_profit: '3560.00' }, result: {}, states })).toBe(true)
    expect(projectionProvesCommandResult({ action: 'position.protection.set', entityKind: 'position', params: { ticket: '1001', remove_stop_loss: true }, result: {}, states })).toBe(false)
  })
})
