import { describe, expect, it } from 'vitest'
import { defaultStructureLayers, readHomePreferences, writeHomePreferences } from './home-preferences'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('home preferences', () => {
  it('round-trips symbol, timeframe and every Chan layer within an account scope', () => {
    const storage = memoryStorage()
    writeHomePreferences(storage, '9', 'account:8', {
      symbol: 'BTCUST', timeframe: 'H1', layers: { bi: false, segment: true, center: false, fractal: true, levels: false },
    })
    expect(readHomePreferences(storage, '9', 'account:8')).toEqual({
      symbol: 'BTCUST', timeframe: 'H1', layers: { bi: false, segment: true, center: false, fractal: true, levels: false },
    })
    expect(readHomePreferences(storage, '9', 'account:7')).toBeNull()
  })

  it('fails closed on malformed storage and fills missing layer values with visible defaults', () => {
    const storage = memoryStorage()
    storage.setItem('aurum.trade.home.v1:9:account%3A8', JSON.stringify({ symbol: '../BTC', timeframe: 'M2', layers: { bi: false } }))
    expect(readHomePreferences(storage, '9', 'account:8')).toEqual({
      symbol: '', timeframe: 'M5', layers: { ...defaultStructureLayers(), bi: false },
    })
    storage.setItem('aurum.trade.home.v1:9:observer%3A1', '{')
    expect(readHomePreferences(storage, '9', 'observer:1')).toBeNull()
  })
})
