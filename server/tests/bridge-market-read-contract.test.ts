import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv from 'ajv/dist/2020.js'
import { parseMarketRead } from '../src/shared/bridge-market-read.js'
const validate = new Ajv({ strict: false }).compile(JSON.parse(readFileSync(new URL('../../contracts/bridge-market-read-v1.schema.json', import.meta.url), 'utf8')))
const base = { v: 1, id: 'd77a048e-19df-4ac7-88c0-33b0258ea6d1', userId: 7, accountId: '2', deadline: 1789364000000, kind: 'instrument', symbol: 'XAUUSD', timeframe: null, before: null, limit: 1, cursor: null }
describe('bounded market read producer/consumer contract', () => {
  it.each([
    base,
    { ...base, kind: 'symbols', symbol: null, limit: 500, cursor: '500' },
    { ...base, kind: 'candles', symbol: 'XAUUSD.s', timeframe: 'M5', before: 1789363999999, limit: 200 },
  ])('accepts fixed read resources', value => { expect(validate(value)).toBe(true); expect(parseMarketRead(value)).toEqual(value) })
  it.each([
    { ...base, kind: 'command' }, { ...base, deadline: -1 }, { ...base, id: '-'.repeat(36) },
    { ...base, kind: 'candles', timeframe: 'M5', before: 1789363999999, limit: 1 },
    { ...base, cursor: '1' }, { ...base, limit: 501 }, { ...base, userId: 0 },
    { ...base, extra: 'ignored' }, { ...base, accountId: '2 OR 1=1' }, { ...base, symbol: '' },
  ])('rejects malformed requests identically', value => { expect(validate(value)).toBe(false); expect(parseMarketRead(value)).toBeNull() })
})
