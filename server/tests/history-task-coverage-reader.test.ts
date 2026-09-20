import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import { historyTaskRoute } from '../src/modules/trade-history/application/history-collection-task.js'
import { historyTaskCompletion } from '../src/modules/trade-history/application/history-task-completion.js'
import { historyCollectionReceipt } from '../src/modules/trade-history/application/history-collection-receipt.js'
import { createMysqlHistoryTaskCoverageReader } from '../src/modules/trade-history/infrastructure/mysql-history-task-coverage-reader.js'
const route: BridgeGatewayRoute = { userId:7,accountId:'5',platform:'mt5',terminalInstanceId:'terminal',terminalProfileId:'profile',brokerServer:'Broker',login:'001',connectionEpoch:3,connectionId:'connection',sessionId:'session',ownershipRevision:'2',timezoneOffsetMinutes:180 }
const taskId = '00000000-0000-4000-8000-000000000001'
function fixture(covered = true) {
  const identity = historyTaskRoute(route)
  const chains = (['history.orders','history.deals'] as const).map(resource => ({resource,rangeStartUtcMsc:1000,rangeEndUtcMsc:2000,source:'terminal' as const,sourceRevision:'r1',pageCount:1,itemCount:0,pageChainHash:'a'.repeat(64),
    ...(covered ? { historyCoverage:{version:1 as const,status:'complete' as const,range_start_utc_msc:1000,range_end_utc_msc:2000,source_revision:'r1',collected_at_utc_msc:2100} } : {}) }))
  const completion = historyTaskCompletion({taskId,accountId:'5',leaseToken:taskId,rangeStartUtcMsc:1000,rangeEndUtcMsc:2000,routeHash:identity.hash},route,chains)
  const receipt = historyCollectionReceipt(route,2000,chains)
  const row = {status:'succeeded',route_json:identity.json,route_sha256:identity.hash,completion_json:completion.json,completion_sha256:completion.hash,result_receipt_id:taskId,
    start_msc:'1000',end_msc:'2000',receipt_id:taskId,receipt_json:receipt.json,receipt_sha256:receipt.hash,receipt_account:'5',receipt_user:7,receipt_platform:'mt5',receipt_terminal:'terminal',receipt_epoch:'3',receipt_ownership:'2',receipt_start:'1000',receipt_end:'2000'}
  const execute = vi.fn().mockResolvedValue([[row]])
  return {row,execute,reader:createMysqlHistoryTaskCoverageReader({execute} as unknown as PoolConnection)}
}
it('returns only validated completed task and receipt evidence',async()=>{
  const f=fixture(), result=await f.reader.read({taskId,route})
  expect(result).toMatchObject({status:'provider_asserted',taskId,receiptId:taskId,rangeStartUtcMsc:1000,rangeEndUtcMsc:2000})
  expect(f.execute.mock.calls[0]![1]).toEqual([taskId,'5'])
  expect(f.execute.mock.calls[0]![0]).not.toContain('FOR UPDATE')
})
it('keeps legacy tasks without coverage unresolved',async()=>{
  expect(await fixture(false).reader.read({taskId,route})).toEqual({status:'unresolved',reason:'coverage_missing'})
})
it.each(['pending','running','completing','failed'])('does not accept %s task',async status=>{
  const f=fixture();f.row.status=status
  expect(await f.reader.read({taskId,route})).toEqual({status:'unresolved',reason:'task_unavailable'})
})
it('does not use evidence from another route',async()=>{
  expect(await fixture().reader.read({taskId,route:{...route,login:'002'}})).toEqual({status:'unresolved',reason:'route_mismatch'})
})
it.each(['route_json','completion_json','completion_sha256','receipt_json','receipt_sha256','receipt_account','receipt_terminal','receipt_epoch','receipt_ownership','receipt_start','receipt_id'] as const)('rejects damaged or mismatched storage: %s',async field=>{
  const f=fixture();f.row[field]='invalid'
  await expect(f.reader.read({taskId,route})).rejects.toThrow('history_task_coverage_corrupt')
})
it('validates task identity before SQL',async()=>{
  const f=fixture()
  await expect(f.reader.read({taskId:'invalid',route})).rejects.toThrow('history_task_coverage_scope_invalid')
  expect(f.execute).not.toHaveBeenCalled()
})
