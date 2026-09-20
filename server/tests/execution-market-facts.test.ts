import {describe,it,expect,vi} from 'vitest'
import type {PoolConnection} from 'mysql2/promise'
import {createMysqlExecutionQuoteReader} from '../src/modules/trading/infrastructure/mysql-execution-quote-reader.js'
import {createMysqlExecutionInstrumentReader} from '../src/modules/trading/infrastructure/mysql-execution-instrument-reader.js'
import {normalizeInstrumentProjection} from '../src/modules/trading/domain/instrument-projection.js'
const route={userId:7,accountId:'5',terminalProfileId:'profile',terminalInstanceId:'terminal',platform:'mt5' as const,brokerServer:'Broker',login:'42',connectionEpoch:1,connectionId:'connection',ownershipRevision:'1'}
const time='2026-09-10T10:00:00.123000Z',observedAt='2026-09-10T10:00:00.123Z'
const quote={symbol:'XAUUSD',bid:'9007199254740992.000000000000000001',ask:'9007199254740992.000000000000000002',revision:3,projection_revision:3,source_revision:3,observed_at:time,source_observed_at:time,age_us:1000,source_age_us:1000}
const raw={symbol:'XAUUSD',point:'0.01',tick_size:'0.01',tick_value:'1',volume_min:'0.01',volume_max:'10',volume_step:'0.01',trade_mode:4}
const payload={...normalizeInstrumentProjection(raw,'XAUUSD'),raw,sourceEvidence:{userId:7,ownershipRevision:'1',terminalProfileId:'profile',terminalInstanceId:'terminal',connectionEpoch:1,sourceRevision:'source',observedAt}}
function fixture(row:object|undefined,kind:'quote'|'instrument'){
  const execute=vi.fn(async(sql:string)=>[sql.includes('FROM bridge_connection_sessions')?[{age_us:1000}]:row?[row]:[]])
  const assert=vi.fn(async()=>{}),connection={execute} as unknown as PoolConnection
  const reader=kind==='quote'?createMysqlExecutionQuoteReader(connection,{assert}):createMysqlExecutionInstrumentReader(connection,{assert})
  return {execute,assert,read:()=>reader.read({route,symbol:'XAUUSD',maxAgeMs:30000,maxInstrumentAgeMs:300000})}
}
describe('trusted current quote',()=>{
  it('preserves adjacent large decimal prices and locks exact source and symbol',async()=>{
    const f=fixture(quote,'quote');expect(await f.read()).toMatchObject({accountId:'5',bid:quote.bid,ask:quote.ask,revision:3,observedAt})
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('FOR SHARE'),['5',7,'1','profile','terminal',1,'XAUUSD'])
  })
  it.each([{projection_revision:2},{source_revision:2},{age_us:-1},{source_age_us:30000001},{source_observed_at:'2026-09-10T10:00:01.123000Z'},
    {bid:0},{bid:'0'},{ask:'1e2'},{symbol:'EURUSD'}])('rejects mismatched or malformed quote %j',async patch=>{
    await expect(fixture({...quote,...patch},'quote').read()).resolves.toBeNull()
  })
})
describe('locked current instrument',()=>{
  const row={payload_json:payload,revision:3,observed_at:time,age_us:1000}
  it('reads normalized contract and exact route proof with shared lock',async()=>{
    const f=fixture(row,'instrument');expect(await f.read()).toEqual({accountId:'5',symbol:'XAUUSD',point:'0.01',tickSize:'0.01',volumeMin:'0.01',volumeMax:'10',volumeStep:'0.01',tradeEnabled:true,revision:3,observedAt})
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('FOR SHARE'),['5','XAUUSD'])
  })
  it.each([{userId:8},{ownershipRevision:'2'},{terminalProfileId:'other'},{terminalInstanceId:'other'},
    {connectionEpoch:2},{observedAt:'2026-09-10T10:00:01.123Z'},{sourceRevision:''}])('rejects replaced route or source proof %j',async patch=>{
    await expect(fixture({...row,payload_json:{...payload,sourceEvidence:{...payload.sourceEvidence,...patch}}},'instrument').read()).resolves.toBeNull()
  })
  it('rejects normalization tampering, invalid raw contract, future and stale observations',async()=>{
    for(const patch of [{payload_json:{...payload,tickSize:'0.001'}},{payload_json:{...payload,raw:{...raw,symbol:'OTHER'}}},
      {payload_json:{...payload,sourceEvidence:undefined}},{age_us:null},{age_us:-1},{age_us:300000001},{revision:0}]){
      await expect(fixture({...row,...patch},'instrument').read()).resolves.toBeNull()
    }
  })
  it('does not turn close-only into an opening permission requirement',async()=>{
    const closedRaw={...raw,trade_mode:3},value={...payload,...normalizeInstrumentProjection(closedRaw,'XAUUSD'),raw:closedRaw}
    expect(await fixture({...row,payload_json:value},'instrument').read()).toMatchObject({tradeEnabled:true})
  })
})
