import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlPositionProtectionSummaryReader } from '../src/modules/risk/infrastructure/mysql-position-protection-summary-reader.js'
import { createMysqlPositionProtectionClock } from '../src/modules/risk/infrastructure/mysql-position-protection-clock.js'
const observedAt='2026-09-10T10:00:00.123Z', sqlTime='2026-09-10T10:00:00.123000Z'
const summary={accountId:'5',userId:7,businessDate:'2026-09-10',equity:'10000',freeMargin:'9000',marginLevelPercent:1000,
  dailyLossPercent:1,drawdownPercent:1,openPositions:1,pendingOrders:0,totalVolume:'0.02',dailyOpenCount:1,consecutiveLosses:0,
  terminalTimezoneOffsetMinutes:180,clockStatus:'calibrated',lastSuccessfulOpenAt:null,cooldownUntil:null,dataComplete:true,incompleteReasons:[],observedAt,revision:4}
const row={payload_json:summary,revision:'4',state_revision:'4',observed_at:sqlTime,state_observed_at:sqlTime}
function fixture(rows: object[]) {
  const execute=vi.fn(async()=>[rows])
  const connection={execute} as unknown as PoolConnection
  return {execute,reader:createMysqlPositionProtectionSummaryReader(connection),clock:createMysqlPositionProtectionClock(connection)}
}
describe('transaction protection summary',()=>{
  it('reads canonical body and matching state versions with retained shared locks',async()=>{
    const f=fixture([row]), result=await f.reader.read(7,'5')
    expect(result).toEqual(summary);expect(result).not.toBe(summary)
    expect(f.execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT 2 FOR SHARE'),['5',7])
  })
  it('preserves complete=false and failure reasons without coercion',async()=>{
    const value={...summary,dataComplete:false,incompleteReasons:['history_missing']}
    await expect(fixture([{...row,payload_json:JSON.stringify(value)}]).reader.read(7,'5')).resolves.toEqual(value)
  })
  it('returns missing separately and refuses ambiguous rows',async()=>{
    await expect(fixture([]).reader.read(7,'5')).resolves.toBeNull()
    await expect(fixture([row,row]).reader.read(7,'5')).rejects.toThrow('position_protection_summary_invalid')
  })
  it.each([{userId:8},{accountId:'6'},{revision:3},{observedAt:'2026-09-10T10:00:01.123Z'},
    {dataComplete:'false'},{dataComplete:undefined},{incompleteReasons:undefined},{incompleteReasons:[1]},
    {clockStatus:'unknown'},{terminalTimezoneOffsetMinutes:undefined},{terminalTimezoneOffsetMinutes:841},
    {totalVolume:'-1'},{equity:1},{equity:'1e3'},{dailyLossPercent:'0'}, {drawdownPercent:NaN},
    {openPositions:1.1},{dailyOpenCount:-1},{marginLevelPercent:undefined},{cooldownUntil:'bad'},
    {businessDate:'2026-02-30'}])('rejects malformed or mismatched body %j',async patch=>{
    await expect(fixture([{...row,payload_json:{...summary,...patch}}]).reader.read(7,'5')).rejects.toThrow('position_protection_summary_invalid')
  })
  it.each([{state_revision:3},{revision:0},{revision:'9007199254740993'}, {state_observed_at:'2026-09-10T10:00:01.123000Z'},
    {observed_at:'2026-02-30T10:00:00.123000Z',state_observed_at:'2026-02-30T10:00:00.123000Z'},
    {observed_at:'2026-09-10T10:00:00.123001Z',state_observed_at:'2026-09-10T10:00:00.123001Z'}, {payload_json:'invalid'}])('rejects inconsistent persisted state %j',async patch=>{
    await expect(fixture([{...row,...patch}]).reader.read(7,'5')).rejects.toThrow('position_protection_summary_invalid')
  })
  it('rejects invalid scope before SQL and preserves database errors',async()=>{
    const f=fixture([row]);await expect(f.reader.read(7,'18446744073709551616')).rejects.toThrow('position_protection_scope_invalid');expect(f.execute).not.toHaveBeenCalled()
    f.execute.mockRejectedValueOnce(Error('database_down'));await expect(f.reader.read(7,'5')).rejects.toThrow('database_down')
  })
})
describe('trusted SQL review clock',()=>{
  it('reads actual UTC calendar milliseconds on the caller connection',async()=>{
    const f=fixture([{zone:'+00:00',now_utc:sqlTime}]);expect((await f.clock.now()).toISOString()).toBe(observedAt)
    expect(f.execute).toHaveBeenCalledWith(expect.stringContaining('UTC_TIMESTAMP(3)'))
  })
  it.each([{zone:'SYSTEM',now_utc:sqlTime},{zone:'+08:00',now_utc:sqlTime},{zone:'UTC',now_utc:'invalid'},
    {zone:'UTC',now_utc:'2026-02-30T00:00:00.000000Z'},{zone:'UTC',now_utc:'2026-09-10T00:00:00.000001Z'}])('refuses an untrusted or malformed clock %j',async value=>{
    await expect(fixture([value]).clock.now()).rejects.toThrow()
  })
})
