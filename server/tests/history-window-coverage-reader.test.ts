import { expect,it,vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import { createMysqlHistoryWindowCoverageReader } from '../src/modules/trade-history/infrastructure/mysql-history-window-coverage-reader.js'
const route:BridgeGatewayRoute={userId:7,accountId:'5',platform:'mt5',terminalInstanceId:'terminal',terminalProfileId:'profile',brokerServer:'Broker',login:'001',connectionEpoch:3,connectionId:'connection',sessionId:'session',ownershipRevision:'2',timezoneOffsetMinutes:180}
const ids=['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001']
const scope={route,rangeStartUtcMsc:1000,rangeEndUtcMsc:2000}
function fixture(){
  const execute=vi.fn().mockResolvedValue([ids.map(id=>({id}))])
  const read=vi.fn().mockResolvedValue({status:'provider_asserted',taskId:ids[0],receiptId:ids[0],completionHash:'a'.repeat(64),rangeStartUtcMsc:500,rangeEndUtcMsc:2500,resources:[]})
  return {execute,read,reader:createMysqlHistoryWindowCoverageReader({execute} as unknown as PoolConnection,{read})}
}
it('uses a single task containing the full requested window and exact route',async()=>{
 const f=fixture();expect((await f.reader.read(scope)).status).toBe('provider_asserted')
 expect(f.read).toHaveBeenCalledOnce()
 expect(f.execute.mock.calls[0]![0]).toContain("status='succeeded' AND route_sha256=?")
 expect(f.execute.mock.calls[0]![1].slice(2)).toEqual([new Date(1000),new Date(2000)])
})
it('skips legacy missing declarations but not damaged evidence',async()=>{
 const f=fixture();f.read.mockResolvedValueOnce({status:'unresolved',reason:'coverage_missing'}).mockResolvedValueOnce({status:'provider_asserted',taskId:ids[1],rangeStartUtcMsc:500,rangeEndUtcMsc:2500})
 expect((await f.reader.read(scope)).status).toBe('provider_asserted')
 const bad=fixture();bad.read.mockRejectedValueOnce(Error('history_task_coverage_corrupt'))
 await expect(bad.reader.read(scope)).rejects.toThrow('history_task_coverage_corrupt');expect(bad.read).toHaveBeenCalledOnce()
})
it.each(['route_mismatch','task_unavailable'])('rejects a candidate changed within the supposed snapshot: %s',async reason=>{
 const f=fixture();f.read.mockResolvedValue({status:'unresolved',reason})
 await expect(f.reader.read(scope)).rejects.toThrow('history_window_coverage_candidate_invalid')
})
it.each([{taskId:ids[1]},{rangeStartUtcMsc:1001},{rangeEndUtcMsc:1999}])('rejects identity or window mismatch %j',async patch=>{
 const f=fixture();f.read.mockResolvedValue({status:'provider_asserted',taskId:ids[0],rangeStartUtcMsc:500,rangeEndUtcMsc:2500,...patch})
 await expect(f.reader.read(scope)).rejects.toThrow('history_window_coverage_candidate_invalid')
})
it('bounds selection without truncating older eligible candidates',async()=>{
 const f=fixture();f.execute.mockResolvedValue([Array.from({length:101},()=>({id:ids[0]}))])
 await expect(f.reader.read(scope)).rejects.toThrow('history_window_coverage_limit_exceeded');expect(f.read).not.toHaveBeenCalled()
})
it('keeps absent and legacy-only candidates unresolved',async()=>{
 const f=fixture();f.execute.mockResolvedValueOnce([[]])
 expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'task_unavailable'})
 f.read.mockResolvedValue({status:'unresolved',reason:'coverage_missing'})
 expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'coverage_missing'})
})
it('validates windows before SQL',async()=>{
 const f=fixture();await expect(f.reader.read({...scope,rangeEndUtcMsc:1000})).rejects.toThrow('history_window_coverage_scope_invalid');expect(f.execute).not.toHaveBeenCalled()
})
