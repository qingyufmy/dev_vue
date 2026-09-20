import {expect,it,vi} from 'vitest'
import type {BridgeGatewayRoute} from '../src/modules/bridge/index.js'
import {ReadOpenPositionHistory} from '../src/modules/trade-history/application/open-position-history-reader.js'
const scope={route:{accountId:'5',platform:'mt5'} as BridgeGatewayRoute,positionIdentifier:'90',symbol:'XAUUSD',side:'buy' as const,volume:'1',observedAtUtcMsc:3000}
function fixture(){
 const lifecycle={read:vi.fn().mockResolvedValue({status:'matches_snapshot',positionIdentifier:'90',side:'buy',volume:'1',dealTickets:['91','92'],contributingOrderTickets:['81']})}
 const start={read:vi.fn().mockResolvedValue(1000)}
 const coverage={read:vi.fn().mockResolvedValue({status:'provider_asserted',taskId:'task',receiptId:'receipt',completionHash:'hash'})}
 const sources={read:vi.fn().mockResolvedValue({status:'source_matched',taskId:'task',receiptId:'receipt',completionHash:'hash',deals:[{ticket:'91'},{ticket:'92'}]})}
 return {lifecycle,start,coverage,sources,reader:new ReadOpenPositionHistory(lifecycle,start,coverage,sources)}
}
it('links the reconciled lifecycle to one full-window task and all deal sources',async()=>{
 const f=fixture();expect(await f.reader.read(scope)).toMatchObject({status:'source_matched',taskId:'task',deals:[{ticket:'91'},{ticket:'92'}]})
 expect(f.coverage.read).toHaveBeenCalledWith({route:scope.route,rangeStartUtcMsc:1000,rangeEndUtcMsc:3000})
 expect(f.sources.read).toHaveBeenCalledWith({taskId:'task',route:scope.route,dealTickets:['91','92']})
})
it('does not consult sources when lifecycle or coverage is unresolved',async()=>{
 const f=fixture();f.lifecycle.read.mockResolvedValueOnce({status:'unresolved',reason:'snapshot_mismatch'})
 expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'lifecycle_unresolved'});expect(f.coverage.read).not.toHaveBeenCalled()
 f.coverage.read.mockResolvedValue({status:'unresolved',reason:'task_unavailable'})
 expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'coverage_unavailable'});expect(f.sources.read).not.toHaveBeenCalled()
})
it.each(['taskId','receiptId','completionHash'])('rejects mixed task evidence: %s',async field=>{
 const f=fixture();f.sources.read.mockResolvedValue({status:'source_matched',taskId:'task',receiptId:'receipt',completionHash:'hash',deals:[{ticket:'91'},{ticket:'92'}],[field]:'other'})
 await expect(f.reader.read(scope)).rejects.toThrow('position_history_source_mismatch')
})
it('keeps missing provenance unresolved instead of returning partial results',async()=>{
 const f=fixture();f.sources.read.mockResolvedValue({status:'unresolved',reason:'source_missing'})
 expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'source_missing'})
})
it('checks complete unique deal membership',async()=>{
 const f=fixture();f.sources.read.mockResolvedValue({status:'source_matched',taskId:'task',receiptId:'receipt',completionHash:'hash',deals:[{ticket:'91'},{ticket:'91'}]})
 await expect(f.reader.read(scope)).rejects.toThrow('position_history_source_mismatch')
})
it.each([null,0,4000,NaN])('rejects invalid history start %s',async time=>{
 const f=fixture();f.start.read.mockResolvedValue(time)
 await expect(f.reader.read(scope)).rejects.toThrow('position_history_window_invalid')
})
it('batches more than 1000 deal IDs while requiring the same completion proof',async()=>{
 const f=fixture(),tickets=Array.from({length:1001},(_,i)=>String(i+1))
 f.lifecycle.read.mockResolvedValue({status:'matches_snapshot',positionIdentifier:'90',side:'buy',volume:'1',dealTickets:tickets,contributingOrderTickets:['81']})
 f.sources.read.mockImplementation(async q=>({status:'source_matched',taskId:'task',receiptId:'receipt',completionHash:'hash',deals:q.dealTickets.map((ticket:string)=>({ticket}))}))
 expect((await f.reader.read(scope)).status).toBe('source_matched');expect(f.sources.read.mock.calls.map(c=>c[0].dealTickets.length)).toEqual([1000,1])
})
