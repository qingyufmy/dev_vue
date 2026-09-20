import Fastify from 'fastify'
import { describe, it, expect, vi } from 'vitest'
import { archivedSignalRoutes } from '../src/modules/inference/transport/http/archived-signal-routes.js'
import { archivedExecutionRoutes } from '../src/modules/execution/transport/http/archived-execution-routes.js'

describe.each(['signals','executions'] as const)('retained %s HTTP', kind => {
  it('uses authenticated ownership, preserves IDs and UTC, and validates pagination and responses', async () => {
    const app=Fastify()
    let userId=7
    const date='2026-09-01T01:02:03.000Z'
    const signal={legacy_id:'18',symbol:'XAUUSD',timeframe:'M5',signal_type:'buy',created_at_utc:date}
    const execution={legacy_id:'18',legacy_account_id:'29',symbol:'XAUUSD',action:'open',status:'completed',created_at_utc:date}
    const list=vi.fn(async()=>({items:[kind==='signals' ? signal : execution],nextCursor:'18'}))
    const get=vi.fn(async(owner:number)=>owner===7 ? (kind==='signals' ? {...signal,analysis:'原分析',reasoning:null,inference_task_id:null}
      : {...execution,trade_ticket:'123456789012345678',pending_ticket:null,error_code:null,completed_at_utc:date}) : null)
    const auth={authenticate:async()=>({userId})}
    // Each transport receives only its own domain reader; this test shares fixtures.
    if(kind==='signals') await app.register(archivedSignalRoutes,{prefix:'/api/v4',auth,reader:{list,get} as unknown as Parameters<typeof archivedSignalRoutes>[1]['reader']})
    else await app.register(archivedExecutionRoutes,{prefix:'/api/v4',auth,reader:{list,get} as unknown as Parameters<typeof archivedExecutionRoutes>[1]['reader']})
    try {
      const base='/api/v4/history/'+kind
      const page=await app.inject(base+'?page_size=1&cursor=20')
      expect(page.statusCode).toBe(200)
      expect(list).toHaveBeenLastCalledWith(7,{limit:1,beforeId:'20'})
      expect(page.json().data).toMatchObject({identity_namespace:'retained-legacy',executable:false,next_cursor:'18'})
      expect(page.headers['cache-control']).toBe('no-store')
      const detail=await app.inject(base+'/18')
      expect(detail.statusCode).toBe(200)
      expect(detail.json().data.created_at_utc).toBe(date)
      if(kind==='executions') expect(detail.json().data.trade_ticket).toBe('123456789012345678')
      if(kind==='executions') {
        list.mockResolvedValueOnce({items:[{...execution,legacy_account_id:null,symbol:null}],nextCursor:null} as never)
        const unknown=await app.inject(base)
        expect(unknown.statusCode).toBe(200)
        expect(unknown.json().data.items[0].legacy_account_id).toBeNull()
        expect(unknown.json().data.items[0].symbol).toBeNull()
      }
      const count=list.mock.calls.length
      for(const query of ['?page_size=101','?cursor=0','?cursor=9223372036854775808','?user_id=0','?account_id=29','?page_size=1&page_size=2']) {
        expect((await app.inject(base+query)).statusCode).toBe(400)
      }
      expect(list.mock.calls).toHaveLength(count)
      expect((await app.inject(base+'/18?user_id=7')).statusCode).toBe(400)
      userId=8
      expect((await app.inject(base+'/18')).statusCode).toBe(404)
      userId=0
      expect((await app.inject(base)).statusCode).toBe(401)
      userId=7
      get.mockRejectedValueOnce(new Error('secret SQL password'))
      const unavailable=await app.inject(base+'/18')
      expect(unavailable.statusCode).toBe(503)
      expect(unavailable.body).not.toContain('secret')
      get.mockResolvedValueOnce({legacy_id:'18'} as never)
      expect((await app.inject(base+'/18')).statusCode).toBe(503)
    } finally { await app.close() }
  })
})
