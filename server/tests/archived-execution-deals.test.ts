import { describe,it,expect,vi } from 'vitest'
import Fastify from 'fastify'
import { ArchivedExecutionDeals } from '../src/modules/trade-history/application/archived-execution-deals.js'
import { archivedExecutionDealRoutes } from '../src/modules/trade-history/transport/http/archived-execution-deal-routes.js'
import type { ArchivedExecutionReader } from '../src/modules/execution/index.js'

describe('archived execution deal scope',()=>{
  const execution={legacy_id:'412',legacy_account_id:'29',symbol:'XAUUSD',action:'open',status:'succeeded',created_at_utc:'2026-09-01T00:00:00.000Z',trade_ticket:null,pending_ticket:null,error_code:null,completed_at_utc:null}
  it('resolves original ownership before history reads and preserves the legacy account namespace',async()=>{
    const get=vi.fn<ArchivedExecutionReader['get']>(async(user)=>user===7?execution:null)
    const list=vi.fn(async()=>({items:[],next_cursor:null}))
    const service=new ArchivedExecutionDeals({get},{list})
    await expect(service.list(8,'412',{limit:20})).rejects.toMatchObject({status:404})
    expect(list).not.toHaveBeenCalled()
    await service.list(7,'412',{limit:1,beforeId:'50'})
    expect(list).toHaveBeenCalledWith({userId:7,legacyAccountId:'29',legacyIntentId:'412',limit:1,beforeId:'50'})
    get.mockResolvedValueOnce({...execution,legacy_account_id:null})
    expect(await service.list(7,'412',{limit:20})).toEqual({items:[],next_cursor:null})
    expect(list).toHaveBeenCalledTimes(1)
    for(const id of ['0','1 OR 1=1','9223372036854775808']) await expect(service.list(7,id,{limit:20})).rejects.toMatchObject({status:400})
  })
  it('validates HTTP scope, decimals, null history and errors without leaking raw rows',async()=>{
    const app=Fastify();let userId=7
    const item={legacy_id:'99',legacy_outcome_id:'44',deal_ticket:'12345678901234567890',position_id:null,order_ticket:null,entry_type:1,
      volume:'0.10000000',price:null,profit:'100000000.12345678',commission:'-0.01000000',swap:'0.00000000',fee:'0.00000000',occurred_at_utc:null}
    const list=vi.fn(async()=>({items:[item],next_cursor:null}))
    const reader=new ArchivedExecutionDeals({get:async(user)=>user===7?execution:null},{list})
    await app.register(archivedExecutionDealRoutes,{prefix:'/api/v4',reader,auth:{authenticate:async()=>({userId})}})
    try{
      const url='/api/v4/history/executions/412/deals'
      const result=await app.inject(url)
      expect(result.statusCode).toBe(200)
      expect(result.json().data.items[0]).toEqual(item)
      expect(result.json().data.executable).toBe(false)
      for(const query of ['?user_id=7','?account_id=29','?page_size=101','?cursor=0','?page_size=2&page_size=3']) expect((await app.inject(url+query)).statusCode).toBe(400)
      userId=8;expect((await app.inject(url)).statusCode).toBe(404)
      userId=0;expect((await app.inject(url)).statusCode).toBe(401)
      userId=7;list.mockRejectedValueOnce(new Error('private SQL'))
      const failed=await app.inject(url);expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('private')
      list.mockResolvedValueOnce({items:[{...item,profit:1}],next_cursor:null} as never)
      expect((await app.inject(url)).statusCode).toBe(503)
    }finally{await app.close()}
  })
})
