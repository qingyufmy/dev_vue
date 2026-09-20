import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlExecutionAccountReader } from '../src/modules/trading/infrastructure/mysql-execution-account-reader.js'
import { TradingAccessError } from '../src/modules/trading/domain/trading.js'
const route={userId:7,accountId:'5',terminalProfileId:'profile',terminalInstanceId:'terminal',platform:'mt5' as const,
  brokerServer:'Broker',login:'42',connectionEpoch:1,connectionId:'connection',installationId:'installation',credentialGeneration:1,ownershipRevision:'1'}
const scope={route,maxAgeMs:30000}
const row={revision:3,projection_revision:3,source_revision:3,observed_at:'2026-09-10T10:00:00.123000Z',
  source_observed_at:'2026-09-10T10:00:00.123000Z',age_us:1000,source_age_us:1000,trade_permission:1,timezone_offset_minutes:180,clock_status:'calibrated'}
function fixture(options:{rows?:object[];sessions?:object[];error?:Error}={}){
  const execute=vi.fn(async(sql:string)=>[sql.includes('account_runtime_snapshots') ? options.rows??[row] : options.sessions??[{age_us:1000}]])
  const assert=vi.fn(async()=>{if(options.error)throw options.error})
  return {execute,assert,reader:createMysqlExecutionAccountReader({execute} as unknown as PoolConnection,{assert})}
}
describe('current execution account facts',()=>{
  it('reads current version, permission and clock with source/session locks',async()=>{
    const f=fixture();await expect(f.reader.read(scope)).resolves.toEqual({accountId:'5',account:{revision:3,observedAt:'2026-09-10T10:00:00.123Z',tradePermission:true,timezoneOffsetMinutes:180,clockStatus:'calibrated'}})
    expect(f.assert).toHaveBeenCalledWith(route)
    expect(f.execute.mock.calls.every(([sql])=>sql.includes('FOR SHARE'))).toBe(true)
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('pp.connection_epoch=?'),['5',7,'1','profile','terminal',1])
  })
  it('preserves denied trading permission and unavailable clock as facts',async()=>{
    const f=fixture({rows:[{...row,trade_permission:0,timezone_offset_minutes:null,clock_status:'unavailable'}]})
    expect((await f.reader.read(scope))!.account).toMatchObject({tradePermission:false,timezoneOffsetMinutes:null,clockStatus:'unavailable'})
  })
  it.each([{revision:0},{projection_revision:2},{source_revision:2},{age_us:null},{age_us:-1},{age_us:30000001},
    {source_age_us:null},{source_age_us:-1},{source_age_us:30000001},{trade_permission:null},{trade_permission:'1'},
    {timezone_offset_minutes:undefined},{timezone_offset_minutes:841},{clock_status:'bad'},
    {source_observed_at:'2026-09-10T10:00:01.123000Z'},
    {observed_at:'2026-02-30T10:00:00.123000Z',source_observed_at:'2026-02-30T10:00:00.123000Z'},
    {observed_at:'2026-09-10T10:00:00.123001Z',source_observed_at:'2026-09-10T10:00:00.123001Z'}])('refuses incomplete/stale/mixed account facts %j',async patch=>{
    await expect(fixture({rows:[{...row,...patch}]}).reader.read(scope)).resolves.toBeNull()
  })
  it.each([[],[{age_us:null}],[{age_us:-1}],[{age_us:30000001}],[{age_us:1000},{age_us:1000}]].map(sessions=>({sessions})))('refuses unavailable/stale/ambiguous sessions %j',async ({sessions})=>{
    const f=fixture({sessions});await expect(f.reader.read(scope)).resolves.toBeNull();expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('refuses missing or ambiguous projections',async()=>{
    for(const rows of [[],[row,row]])await expect(fixture({rows}).reader.read(scope)).resolves.toBeNull()
  })
  it('does not suppress database failures or start a new transaction',async()=>{
    const f=fixture({error:Error('database_down')});await expect(f.reader.read(scope)).rejects.toThrow('database_down');expect(f.execute).not.toHaveBeenCalled()
    await expect(fixture({error:new TradingAccessError('trading_context_invalid',403)}).reader.read(scope)).resolves.toBeNull()
  })
  it.each([0,60001,NaN])('validates age bounds before SQL %s',async maxAgeMs=>{
    const f=fixture();await expect(f.reader.read({...scope,maxAgeMs})).resolves.toBeNull();expect(f.assert).not.toHaveBeenCalled()
  })
})
