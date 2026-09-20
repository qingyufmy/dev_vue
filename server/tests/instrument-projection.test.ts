import { expect, it } from 'vitest'
import { normalizeInstrumentProjection } from '../src/modules/trading/domain/instrument-projection.js'

const raw = { symbol: 'XAUUSD.a', point: '0.01', tick_size: '0.01', tick_value: '1.000000000000000001',
  volume_min: '0.01', volume_max: '100', volume_step: '0.01', trade_mode: 4 }
it('preserves MT4 decimal text and broker symbol suffix', () => {
  expect(normalizeInstrumentProjection(raw, 'XAUUSD.a')).toMatchObject({ symbol: 'XAUUSD.a', tickValue: '1.000000000000000001', allowedOpenSides: ['buy', 'sell'] })
})
it('accepts the received MT5 numeric representation including small exponential numbers', () => {
  const { symbol: _, ...mt5 } = raw
  expect(normalizeInstrumentProjection({ ...mt5, name: 'XAUUSD.a', point: 1e-7, tick_size: 1e-7, tick_value: 0.1 }, 'XAUUSD.a'))
    .toMatchObject({ point: '0.0000001', tickSize: '0.0000001', tickValue: '0.1' })
})
it('retains closing-only as a permission with no opening sides', () => {
  expect(normalizeInstrumentProjection({ ...raw, trade_mode: 3 }, 'XAUUSD.a')).toMatchObject({ tradeEnabled: true, allowedOpenSides: [], trade_mode: 3 })
})
it.each([{ symbol: 'XAUUSD' }, { name: 'other' }, { tick_size: 0 }, { point: null }, { volume_max: '0.001' },
  { volume_step: '101' }, { tick_value: Infinity }, { trade_mode: 5 }, { point: 1e-19 }, { volume_max: Number.MAX_SAFE_INTEGER + 1 }])(
  'rejects incomplete or inconsistent terminal data %j', patch => {
    expect(() => normalizeInstrumentProjection({ ...raw, ...patch }, 'XAUUSD.a')).toThrow('instrument_projection_invalid')
  },
)
