import { describe,it,expect,vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { assertMysqlQuoteProvenanceCapability,createMysqlQuoteProvenanceWriter } from '../src/modules/trading/infrastructure/mysql-quote-provenance-writer.js'
const clause="(`resource_kind` in (_ascii'account.metrics',_ascii'positions',_ascii'pending_orders',_ascii'market.quote'))"
const input={route:{accountId:'5',userId:7,terminalProfileId:'profile',terminalInstanceId:'terminal',connectionEpoch:1,ownershipRevision:'3'},ownership:{intervalId:'interval',ownershipRevision:'3'},
  projection:{accountId:'5',resource:'market.quote' as const,resourceId:'XAUUSD',revision:4,data:{accountId:'5',symbol:'XAUUSD',bid:'2500',ask:'2500.1',last:null,spread:'0.1',tradeMode:'full' as const,observedAt:'2026-09-10T10:00:00.123Z',revision:4}}}
function fixture(rows:object[]=[{clause,enforced:'YES'}]) {
  const execute=vi.fn(async(sql:string)=>[sql.includes('information_schema')?rows:[]])
  const connection={execute} as unknown as PoolConnection
  return {execute,connection,writer:createMysqlQuoteProvenanceWriter(connection)}
}
describe('quote source writer',()=>{
  it('writes exact trusted source in caller transaction with SQL UTC milliseconds',async()=>{
    const f=fixture();await f.writer.write(input)
    expect(f.execute).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO trading_projection_provenance_v4'),['5','XAUUSD',7,'interval','3','profile','terminal',1,4,'2026-09-10 10:00:00.123'])
  })
  it.each([[],[{clause:clause.replace(",_ascii'market.quote'",''),enforced:'YES'}],[{clause,enforced:'NO'}],
    [{clause:clause+' OR 1=1',enforced:'YES'}],[{clause,enforced:'YES'},{clause,enforced:'YES'}]].map(rows=>({rows})))('rejects missing/old/weakened/ambiguous constraint %j',async({rows})=>{
    const f=fixture(rows);await expect(assertMysqlQuoteProvenanceCapability(f.connection)).rejects.toThrow('quote_provenance_schema_not_ready')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('accepts MySQL metadata escaped UTF8 literal rendering without relaxing kind values',async()=>{
    const mysqlClause=clause.replaceAll('_ascii','_utf8mb4').replaceAll("'",String.fromCharCode(92)+"'")
    await expect(assertMysqlQuoteProvenanceCapability(fixture([{clause:mysqlClause,enforced:'YES'}]).connection)).resolves.toBeUndefined()
  })
  it('rejects mismatched account, revision, source and invalid time before writes',async()=>{
    for(const patch of [{accountId:'6'},{revision:3},{observedAt:'bad'}]) {
      const f=fixture();await expect(f.writer.write({...input,projection:{...input.projection,data:{...input.projection.data,...patch}}})).rejects.toThrow('trading_context_invalid');expect(f.execute).not.toHaveBeenCalled()
    }
    const f=fixture();await expect(f.writer.write({...input,ownership:{...input.ownership,ownershipRevision:'4'}})).rejects.toThrow('trading_context_invalid')
  })
  it('does not swallow schema or SQL failures',async()=>{
    const f=fixture();f.execute.mockRejectedValueOnce(Error('db_down'));await expect(f.writer.write(input)).rejects.toThrow('db_down')
  })
})
