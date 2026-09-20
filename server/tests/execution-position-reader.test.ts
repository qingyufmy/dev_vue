import { createMysqlExecutionPositionCollectionReader } from '../src/modules/trading/infrastructure/mysql-execution-position-collection-reader.js'
import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlExecutionPositionReader } from '../src/modules/trading/infrastructure/mysql-execution-position-reader.js'
import { TradingAccessError } from '../src/modules/trading/domain/trading.js'
import { createPartialCloseRegistrationTargetReader } from '../src/bootstrap/partial-close-registration.js'

const route = { userId:7,accountId:'5',terminalProfileId:'profile',terminalInstanceId:'terminal',platform:'mt5' as const,
  brokerServer:'Broker',login:'42',connectionEpoch:1,connectionId:'connection',installationId:'installation',credentialGeneration:1,ownershipRevision:'1',
  timezoneOffsetMinutes:180,sessionId:'session' }
const scope = { route,ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy' as const,revision:5,maxAgeMs:30000 }
const item = { accountId:'5',ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy',volume:'0.10',revision:5 }
const source = { revision:5,projection_revision:5,observed_at:'2026-09-10T10:00:00.123000Z',age_us:1000 }
function fixture(options: { source?:object[]; rows?:object[]; enabled?:object[]; sessions?:object[]; guardError?:Error } = {}) {
  const execute = vi.fn(async (sql:string) => {
    if (sql.includes('user_trading_account_settings')) return [options.enabled ?? [{id:'5'}]]
    if (sql.includes('FROM bridge_connection_sessions')) return [options.sessions ?? [{age_us:1000}]]
    if (sql.includes('trading_projection_provenance_v4')) return [options.source ?? [source]]
    if (sql.includes('FROM open_position_snapshots')) return [options.rows ?? [{ticket:'101',revision:5,payload_json:item}]]
    throw Error('unexpected_query')
  })
  const assert = vi.fn(async()=>{if(options.guardError)throw options.guardError})
  return { execute,assert,collection:createMysqlExecutionPositionCollectionReader({execute} as unknown as PoolConnection,{assert}),reader:createMysqlExecutionPositionReader({execute} as unknown as PoolConnection,{assert}) }
}
describe('transaction execution position reader',()=>{
  it('returns stable identity from an authorized complete projection with locks retained',async()=>{
    const f=fixture()
    await expect(f.reader.read(scope)).resolves.toEqual({...item,observedAt:'2026-09-10T10:00:00.123Z'})
    expect(f.assert).toHaveBeenCalledWith(route)
    expect(f.execute.mock.calls.every(([sql])=>sql.includes('FOR SHARE'))).toBe(true)
    expect(f.execute.mock.calls.find(([sql])=>sql.includes('open_position_snapshots'))![0]).not.toContain('ticket=?')
  })
  it('does not suppress infrastructure failures as absent positions',async()=>{
    await expect(fixture({guardError:Error('database_down')}).reader.read(scope)).rejects.toThrow('database_down')
    const f=fixture({guardError:new TradingAccessError('trading_context_invalid',403)})
    await expect(f.reader.read(scope)).resolves.toBeNull()
    expect(f.execute).not.toHaveBeenCalled()
  })
  it.each([{sessions:[{age_us:null}]},{source:[{...source,age_us:null}]},{enabled:[]},{sessions:[]},{sessions:[{age_us:-1}]},{sessions:[{age_us:30000001}]},{source:[]},
    {source:[{...source,revision:4}]},{source:[{...source,projection_revision:4}]},{source:[{...source,age_us:-1}]},
    {source:[{...source,age_us:30000001}]},{source:[{...source,observed_at:'bad'}]}])('rejects disabled, disconnected or stale evidence %j',async options=>{
    await expect(fixture(options).reader.read(scope)).resolves.toBeNull()
  })
  it.each([{accountId:'6'},{ticket:'102'},{positionIdentifier:null},{positionIdentifier:'999'}, {symbol:'EURUSD'},
    {side:'sell'},{revision:4},{volume:'0'},{volume:'1e2'}])('rejects changed position identity or state %j',async patch=>{
    await expect(fixture({rows:[{ticket:'101',revision:5,payload_json:{...item,...patch}}]}).reader.read(scope)).resolves.toBeNull()
  })
  it('rejects a mixed full collection, duplicate stable identities and corrupt payloads',async()=>{
    for(const extra of [{ticket:'102',revision:4,payload_json:{...item,ticket:'102',revision:4}},
      {ticket:'102',revision:5,payload_json:{...item,ticket:'102'}},{ticket:'102',revision:5,payload_json:'invalid'}]) {
      await expect(fixture({rows:[{ticket:'101',revision:5,payload_json:item},extra]}).reader.read(scope)).resolves.toBeNull()
    }
  })
  it('does not support MT4 or invalid target IDs and bounds',async()=>{
    for(const input of [{...scope,route:{...route,platform:'mt4' as const}},{...scope,maxAgeMs:60001},
      {...scope,positionIdentifier:'18446744073709551616'},{...scope,revision:0}]) {
      const f=fixture();await expect(f.reader.read(input)).resolves.toBeNull();expect(f.assert).not.toHaveBeenCalled()
    }
  })
  it('binds the command epoch and rechecks every returned target field in bootstrap',async()=>{
    const target={userId:'7',accountId:'5',terminalInstanceId:'terminal',brokerServer:'Broker',login:'42',positionIdentifier:'100',ticket:'101',symbol:'XAUUSD',side:'buy' as const}
    const read=vi.fn(async()=>({...item,side:'buy' as const,observedAt:'2026-09-10T10:00:00.123Z'}))
    const adapter=createPartialCloseRegistrationTargetReader({read},route,30000)
    await expect(adapter.read({target,revision:5,connectionEpoch:2})).resolves.toBeNull()
    expect(read).not.toHaveBeenCalled()
    await expect(adapter.read({target,revision:5,connectionEpoch:1})).resolves.toEqual({target,revision:5,volume:'0.10'})
    read.mockResolvedValueOnce({...item,positionIdentifier:'999',side:'buy',observedAt:'2026-09-10T10:00:00.123Z'})
    await expect(adapter.read({target,revision:5,connectionEpoch:1})).resolves.toBeNull()
  })
})


describe('authorized complete execution position collection', () => {
  it('distinguishes a proven empty collection from unavailable provenance', async () => {
    await expect(fixture({rows:[]}).collection.read({route,maxAgeMs:30000})).resolves.toEqual({accountId:'5',revision:5,observedAt:'2026-09-10T10:00:00.123Z',positions:[]})
    await expect(fixture({source:[],rows:[]}).collection.read({route,maxAgeMs:30000})).resolves.toBeNull()
  })
  it('reads the current revision while the existing exact-revision target reader still rejects drift', async () => {
    const f=fixture({source:[{...source,revision:6,projection_revision:6}],rows:[{ticket:'101',revision:6,payload_json:{...item,revision:6,volume:'0.02'}}]})
    await expect(f.collection.read({route,maxAgeMs:30000})).resolves.toMatchObject({revision:6,positions:[{ticket:'101',positionIdentifier:'100',volume:'0.02'}]})
    await expect(f.reader.read(scope)).resolves.toBeNull()
  })
  it('keeps unrelated positions in the validated collection, including explicitly unknown stable identities', async () => {
    const f=fixture({rows:[{ticket:'101',revision:5,payload_json:item},{ticket:'102',revision:5,payload_json:{...item,ticket:'102',positionIdentifier:null}}]})
    const result=await f.collection.read({route,maxAgeMs:30000})
    expect(result!.positions).toHaveLength(2)
    expect(result!.positions[1]!.positionIdentifier).toBeNull()
  })
  it.each(['2026-02-30T00:00:00.123000Z','2026-09-10T10:00:00.123001Z'])('rejects impossible or non-millisecond source time %s', observed_at => {
    return expect(fixture({source:[{...source,observed_at}]}).collection.read({route,maxAgeMs:30000})).resolves.toBeNull()
  })
})


describe('current protection facts in the locked complete collection', () => {
  it('preserves explicit absence and exact large decimal prices', async () => {
    const f=fixture({rows:[{ticket:'101',revision:5,payload_json:{...item,stopLoss:null,takeProfit:'9007199254740992.000000000000000001'}}]})
    const result=await f.collection.read({route,maxAgeMs:30000})
    expect(result!.positions[0]).toMatchObject({stopLoss:null,takeProfit:'9007199254740992.000000000000000001'})
  })
  it.each([undefined,0,'0','-1','1e3',{},'NaN'])('keeps missing or malformed prices unknown: %j', async price => {
    const f=fixture({rows:[{ticket:'101',revision:5,payload_json:{...item,stopLoss:price,takeProfit:price}}]})
    const result=await f.collection.read({route,maxAgeMs:30000})
    expect(result).not.toBeNull()
    expect(result!.positions[0]).not.toHaveProperty('stopLoss')
    expect(result!.positions[0]).not.toHaveProperty('takeProfit')
  })
  it('still rejects corrupted whole-collection identity when protection is valid', async () => {
    const f=fixture({rows:[{ticket:'101',revision:5,payload_json:{...item,stopLoss:'2400',takeProfit:null}},
      {ticket:'102',revision:5,payload_json:{...item,ticket:'102',stopLoss:'2400',takeProfit:null}}]})
    await expect(f.collection.read({route,maxAgeMs:30000})).resolves.toBeNull()
  })
})
