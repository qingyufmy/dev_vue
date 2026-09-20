import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, it } from 'vitest'
import { BridgeTradeProjectionDecoder, type BridgeGatewayRoute, type BridgeStreamEventEnvelope } from '../src/modules/bridge/index.js'

const schema = JSON.parse(readFileSync(new URL('../../contracts/bridge-v4.schema.json', import.meta.url), 'utf8'))
const validate = new Ajv2020({ strict: false }).compile({ $defs: schema.$defs, $ref: '#/$defs/PositionStreamItem' })
const item = { ticket: '1001', symbol: 'XAUUSD', direction: 'buy', order_type: 'market', magic: 7,
  volume: '0.10', open_price: '3540.20', current_price: '3541.00', stop_limit_price: null, stop_loss: null,
  take_profit: null, expiration_utc_msc: null, profit: '8.00', opened_at_utc_msc: 1_788_423_000_000 }
const decode = async (row: Record<string, unknown>) => new BridgeTradeProjectionDecoder().decode({ accountId: '7' } as BridgeGatewayRoute,
  { payload: { stream: 'positions', full_snapshot: true, deletes: [], revision: 9, observed_at_utc_msc: 1_788_423_600_000, upserts: [row] } } as unknown as BridgeStreamEventEnvelope)

it('accepts old producers without inventing a stable identifier', async () => {
  expect(validate(item)).toBe(true)
  const result = await decode(item)
  expect(result).toMatchObject({ data: [{ ticket: '1001' }], tradeStates: [{ ticket: '1001' }] })
  if (result?.resource !== 'positions') throw new Error('expected_positions')
  expect(result.data[0]).not.toHaveProperty('positionIdentifier')
})

it.each([null, '1', '9007199254740993', '18446744073709551615'])('preserves stable identifier %s without changing command state', async identifier => {
  const row = { ...item, position_identifier: identifier }
  expect(validate(row)).toBe(true)
  const previous = await decode(item), current = await decode(row)
  expect(current).toMatchObject({ data: [{ ticket: '1001', positionIdentifier: identifier }] })
  expect((current as { tradeStates: unknown }).tradeStates).toEqual((previous as { tradeStates: unknown }).tradeStates)
})

it.each([0, 9007199254740992, '0', '01', '-1', '1.0', '', '18446744073709551616', '99999999999999999999'])('rejects invalid identifier %s in schema and decoder', async identifier => {
  const row = { ...item, position_identifier: identifier }
  expect(validate(row)).toBe(false)
  await expect(decode(row)).rejects.toMatchObject({ code: 'bridge_trade_snapshot_position_identifier_invalid' })
})
