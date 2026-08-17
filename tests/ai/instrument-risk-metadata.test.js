import { describe, expect, it } from 'vitest'
import { validateRiskInstrument } from '../../server/routes/ai/instrument-risk-metadata.js'

const baseInstrument = {
  name: 'XAUUSD',
  tick_value: 1,
  tick_size: 0.01,
  contract_size: 100,
  volume_min: 0.01,
  volume_max: 100,
  volume_step: 0.01,
  digits: 2,
  point: 0.01,
  trade_mode: 4,
}

describe('risk snapshot instrument metadata validation', () => {
  it('keeps complete legacy MT5 metadata compatible and normalizes numeric strings', () => {
    const result = validateRiskInstrument({
      ...baseInstrument,
      tick_value: '1', tick_size: '0.01', digits: '2', point: '0.01',
    }, { account: { platform: 'mt5' } })

    expect(result).toMatchObject({ valid: true, status: 'legacy', reasons: [] })
    expect(result.instrument).toMatchObject({ tick_value: 1, tick_size: 0.01, digits: 2, point: 0.01 })
    expect(result.evidence).toMatchObject({ platform: 'mt5', instrument_validation_status: 'legacy' })
  })

  it('preserves EA source and candidate evidence for a valid specification', () => {
    const result = validateRiskInstrument({
      ...baseInstrument,
      tick_size_raw_marketinfo: 0.01,
      tick_size_marketinfo_price_candidate: 0.0001,
      tick_size_symbolinfo_candidate: 0.01,
      tick_size_source: 'symbol_info_trade_tick_size',
      instrument_validation_status: 'valid',
      instrument_validation_reasons: ['marketinfo_semantic_mismatch'],
      bridge_version: '3.0.3',
      ea_version: '3.0.3',
    }, { snapshot: { source: 'mt4' } })

    expect(result.valid).toBe(true)
    expect(result.status).toBe('valid')
    expect(result.instrument).toMatchObject({
      tick_size: 0.01,
      tick_size_source: 'symbol_info_trade_tick_size',
      instrument_validation_status: 'valid',
    })
    expect(result.validation_reasons).toContain('marketinfo_semantic_mismatch')
    expect(result.evidence).toMatchObject({
      platform: 'mt4', bridge_version: '3.0.3', ea_version: '3.0.3',
      tick_size_raw_marketinfo: 0.01,
      tick_size_marketinfo_price_candidate: 0.0001,
      tick_size_symbolinfo_candidate: 0.01,
      tick_size_source: 'symbol_info_trade_tick_size',
    })
  })

  it.each(['ambiguous', 'invalid'])('fails closed for EA validation status %s', status => {
    const result = validateRiskInstrument({ ...baseInstrument, instrument_validation_status: status })

    expect(result.valid).toBe(false)
    expect(result.status).toBe('invalid')
    expect(result.reasons).toContainEqual(expect.objectContaining({
      code: 'bridge_validation_status_rejected', status,
    }))
    expect(result.instrument.instrument_validation_status).toBe('invalid')
  })

  it('fails closed for an unknown EA validation status', () => {
    const result = validateRiskInstrument({ ...baseInstrument, instrument_validation_status:'future_guess' })
    expect(result.valid).toBe(false)
    expect(result.reasons).toContainEqual(expect.objectContaining({
      code:'bridge_validation_status_unknown', status:'future_guess',
    }))
  })

  it('rejects non-finite core values, invalid volume lattice, and sub-digit tick size', () => {
    const result = validateRiskInstrument({
      ...baseInstrument,
      tick_value: 0,
      tick_size: 0.0001,
      volume_max: 0.11,
      volume_step: 0.03,
      digits: 2,
    })

    expect(result.valid).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'field_not_positive', field: 'tick_value' }),
      expect.objectContaining({ code: 'volume_lattice_invalid' }),
      expect.objectContaining({ code: 'tick_size_below_digits_precision' }),
    ]))
  })

  it('rejects a final tick size that is not on the quoted point lattice', () => {
    const result = validateRiskInstrument({ ...baseInstrument, tick_size:0.015 })
    expect(result.valid).toBe(false)
    expect(result.reasons).toContainEqual(expect.objectContaining({
      code:'tick_size_not_aligned_to_point', tick_size:0.015, point:0.01,
    }))
  })

  it('keeps unavailable optional candidates as warnings when fallback is final and valid', () => {
    const result = validateRiskInstrument({
      ...baseInstrument,
      tick_size_source: 'market_info_points',
      instrument_validation_status: 'fallback',
      tick_size_raw_marketinfo: 0,
      tick_size_marketinfo_price_candidate: 0,
      tick_size_symbolinfo_candidate: 0,
    })

    expect(result.valid).toBe(true)
    expect(result.status).toBe('fallback')
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'tick_size_candidate_unavailable' }),
    ]))
  })
})
