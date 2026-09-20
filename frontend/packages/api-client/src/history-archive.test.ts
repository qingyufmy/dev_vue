import { it, expect, vi } from 'vitest'
import { createApiClient } from './index.js'
import { archivedExecutionDealsResponseSchema } from '@aurum/contracts'
it('reads legacy data with the current cookie and refuses executable or mistyped payloads', async () => {
  const payload={data:{identity_namespace:'retained-legacy',executable:false,items:[],next_cursor:null},meta:{request_id:'archive',generated_at:'2026-09-12T00:00:00.000Z'}}
  const fetchImpl=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify(payload),{status:200}))
  const client=createApiClient({fetchImpl})
  await client.listArchivedSignals(20,'123456789012345678')
  expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/history/signals?page_size=20&cursor=123456789012345678')
  expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({credentials:'same-origin',cache:'no-store'})
  expect(()=>client.listArchivedSignals(101)).toThrow()
  expect(()=>client.listArchivedSignals(20,'0')).toThrow()
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  await client.listArchivedExecutions()
  payload.data.executable=true
  await expect(client.listArchivedSignals()).rejects.toThrow()
  payload.data.executable=false
  payload.data.identity_namespace='v4'
  await expect(client.listArchivedExecutions()).rejects.toThrow()
})

it('validates original deal tickets and decimal values without numeric coercion',async()=>{
  const data={legacy_execution_id:'412',identity_namespace:'retained-legacy',executable:false,next_cursor:null,items:[{
    legacy_id:'99',legacy_outcome_id:'44',deal_ticket:'12345678901234567890',position_id:null,order_ticket:null,entry_type:null,
    volume:'0.10000000',price:null,profit:'100000000.12345678',commission:'-0.01000000',swap:'0.00000000',fee:'0.00000000',occurred_at_utc:null}]}
  const payload={data,meta:{request_id:'test',generated_at:'2026-09-13T00:00:00.000Z'}}
  const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload),{status:200}))
  const client=createApiClient({fetchImpl})
  const result=await client.listArchivedExecutionDeals('412',1,'100')
  expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/history/executions/412/deals?page_size=1&cursor=100')
  expect(result.data.items[0]?.profit).toBe('100000000.12345678')
  expect(archivedExecutionDealsResponseSchema.safeParse({...payload,data:{...data,items:[{...data.items[0],profit:1}]}}).success).toBe(false)
})
