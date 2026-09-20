import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, it, expect } from 'vitest'
import { BridgeTradeProjectionDecoder, BridgeV4StreamIngestor, type BridgeGatewayRoute, type BridgeStreamEventEnvelope } from '../src/modules/bridge/index.js'
const schema = JSON.parse(readFileSync(new URL('../../contracts/bridge-v4.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv2020({ strict: false })
const validate = ajv.compile({ $ref: '#/$defs/StreamEvent', $defs: schema.$defs })
const route = { platform: 'mt5', userId: 42, accountId: '7', terminalProfileId: 'profile_12345678', terminalInstanceId: 'terminal_12345678', brokerServer: 'Demo', login: '860058', connectionEpoch: 2, connectionId: 'connection_12345678', sessionId: 'session_12345678', timezoneOffsetMinutes: null } satisfies BridgeGatewayRoute
function event(): BridgeStreamEventEnvelope {
  return { v: 4, type: 'stream.event', message_id: 'account_12345678', correlation_id: null, sent_at_utc_msc: 1788423600000,
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { login: route.login, broker_server: route.brokerServer }, connection_epoch: 2 },
    payload: { subscription_id: 'account-snapshot', stream: 'account', revision: 1788423600000, base_revision: 0, full_snapshot: true,
      observed_at_utc_msc: 1788423600000, source_time_msc: null, deletes: [], upserts: [{ balance: '9007199254740993.12', equity: '1234.56', margin: '0', free_margin: '-1.25', floating_profit: '-9.25', currency: 'USD', leverage: 100, trade_permission: false }] } }
}
describe('Bridge account snapshots', () => {
  it('preserves money text, derives identity exclusively from the authorized route and leaves clock unproved', async () => {
    const value = event()
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true)
    expect(await new BridgeTradeProjectionDecoder().decode(route, value)).toMatchObject({ resource: 'account.metrics', resourceId: 'current', data: { id: '7', login: '860058', balance: '9007199254740993.12', freeMargin: '-1.25', tradePermission: false, timezoneOffsetMinutes: null, clockStatus: 'unavailable' } })
  })
  it('rejects stale observations before persistence', async () => {
    let writes = 0
    const stream = new BridgeV4StreamIngestor(new BridgeTradeProjectionDecoder(), { async ingest() { writes++; return true } }, () => new Date(1788423670000))
    await expect(stream.ingest(route, event())).rejects.toMatchObject({ code: 'bridge_account_snapshot_stale' })
    expect(writes).toBe(0)
  })
  it.each(['identity', 'number', 'partial', 'delete', 'empty', 'leverage'])('rejects invalid %s in both contract and consumer', async kind => {
    const value = event(), item = value.payload.upserts[0]!
    if (kind === 'identity') item.account_id = '8'
    if (kind === 'number') item.balance = 123.45
    if (kind === 'partial') value.payload.full_snapshot = false
    if (kind === 'delete') value.payload.deletes = ['current']
    if (kind === 'empty') value.payload.upserts = []
    if (kind === 'leverage') item.leverage = -1
    expect(validate(value)).toBe(false)
    await expect(new BridgeTradeProjectionDecoder().decode(route, value)).rejects.toMatchObject({ code: 'bridge_account_snapshot_invalid' })
  })
})

function sampled(at: number, raw = at + 180 * 60000, monotonic = at - 1000000) {
  const value = event()
  value.payload.observed_at_utc_msc = at
  value.payload.upserts[0]!.clock_sample = { symbol: 'XAUUSD.s', raw_time_msc: raw,
    started_at_msc: at - 2, sampled_at_msc: at, monotonic_msc: monotonic }
  return value
}
it('calibrates only advancing consistent samples from the same connection', async () => {
  const decoder = new BridgeTradeProjectionDecoder(), at = 1788423600000
  const first = sampled(at), second = sampled(at + 10000)
  expect(validate(second), JSON.stringify(validate.errors)).toBe(true)
  expect(await decoder.decode(route, first)).toMatchObject({ data: { clockStatus: 'unavailable' } })
  expect(await decoder.decode(route, second)).toMatchObject({ data: { timezoneOffsetMinutes: 180, clockStatus: 'calibrated' } })
  expect(await decoder.decode({ ...route, connectionEpoch: 3 }, sampled(at + 20000))).toMatchObject({ data: { clockStatus: 'unavailable' } })
})
it.each(['frozen', 'host-jump', 'offset-change', 'slow', 'missing', 'replay'])('does not calibrate %s evidence', async kind => {
  const decoder = new BridgeTradeProjectionDecoder(), at = 1788423600000
  await decoder.decode(route, sampled(at))
  const value = sampled(at + 10000), sample = value.payload.upserts[0]!.clock_sample as Record<string, unknown>
  if (kind === 'frozen') sample.raw_time_msc = at + 180 * 60000
  if (kind === 'host-jump') sample.monotonic_msc = at - 1000000 + 5000
  if (kind === 'offset-change') sample.raw_time_msc = at + 10000 + 120 * 60000
  if (kind === 'slow') sample.started_at_msc = at
  if (kind === 'missing') delete value.payload.upserts[0]!.clock_sample
  if (kind === 'replay') sample.sampled_at_msc = at
  expect(await decoder.decode(route, value)).toMatchObject({ data: { clockStatus: 'unavailable', timezoneOffsetMinutes: null } })
})

it('accepts a complete fresh pair carried through intervening internal account checks', async () => {
  const at = 1788423600000, value = sampled(at + 10000)
  const sample = value.payload.upserts[0]!.clock_sample as Record<string, unknown>
  sample.previous = sampled(at).payload.upserts[0]!.clock_sample
  value.payload.observed_at_utc_msc += 10000
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true)
  expect(await new BridgeTradeProjectionDecoder().decode(route, value)).toMatchObject({ data: { clockStatus: 'calibrated', timezoneOffsetMinutes: 180 } })
  value.payload.observed_at_utc_msc += 60000
  expect(await new BridgeTradeProjectionDecoder().decode(route, value)).toMatchObject({ data: { clockStatus: 'unavailable' } })
})
