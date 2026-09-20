import { it, expect, vi } from 'vitest'
import { MarketGapConfirmations } from '../src/bootstrap/market-gap-confirmation-runtime.js'
import { unresolvedMarketGap } from '../src/modules/market/index.js'
const step=3600000, from='2026-09-11T20:00:00.000Z', to='2026-09-13T22:00:00.000Z'
function fixture() {
 const values=new Map<string,string>(), queue=new Map<string,number>()
 const cache={ get:vi.fn(async(k:string)=>values.get(k)??null), set:vi.fn(async(k:string,v:string)=>{values.set(k,v)}),
 zadd:vi.fn(async(_k:string,a:any,b:any,c?:string)=>{const raw=c??b,score=c?b:a;if(!c||!queue.has(raw))queue.set(raw,score)}),
 zrangebyscore:vi.fn(async()=>[...queue.keys()].slice(0,1)), zrem:vi.fn(async(_k:string,r:string)=>{queue.delete(r)}) }
 const selection:any={pool:{kind:'public'},standardSymbol:'XAUUSD',state:{generation:1,revision:1,lastCheckedAt:1,resolvedSymbol:'XAUUSD.s',source:{ownerUserId:1,accountId:'1',connectionId:'c',connectionEpoch:1}}}
 const candle=(openTime:string)=>({accountId:'1',symbol:'XAUUSD.s',timeframe:'H1',openTime,open:'2',high:'3',low:'1',close:'2',tickVolume:'1',closed:true,revision:1})
 const items=[candle(from),candle(to)], service=new MarketGapConfirmations(cache as any)
 const selector={isCurrent:vi.fn(async()=>true)}, route={accountId:'1',userId:1,connectionId:'c',connectionEpoch:1}, routes={current:vi.fn(async()=>route)}
 const io={read:vi.fn(async()=>({items})),write:vi.fn(async()=>{})}
 return {service,selection,items,selector,routes,io,cache,queue,candle}
}
it('confirms only after a successful comparison and reuses an exact-source marker',async()=>{
 const f=fixture();expect(await f.service.read(f.selection,'H1',f.items,step)).toEqual([])
 await f.service.read({...f.selection,state:{...f.selection.state,lastCheckedAt:99,revision:7}},'H1',f.items,step)
 expect(f.queue.size).toBe(1)
 await f.service.tick(f.selector as any,f.routes as any,f.io as any)
 expect(f.io.read).toHaveBeenCalledTimes(1);expect(f.io.write).toHaveBeenCalled()
 const gaps=await f.service.read(f.selection,'H1',f.items,step)
 expect(gaps).toEqual([{from,to}]);expect(unresolvedMarketGap([Date.parse(from),Date.parse(to)],step,gaps)).toBe(false)
 expect(await f.service.read({...f.selection,state:{...f.selection.state,source:{...f.selection.state.source,accountId:'2'}}},'H1',f.items,step)).toEqual([])
})
it.each(['error','missing','changed'])('does not confirm %s response',async(kind)=>{
 const f=fixture();await f.service.read(f.selection,'H1',f.items,step)
 if(kind==='error') f.io.read.mockRejectedValue(new Error('timeout'))
 if(kind==='missing') f.io.read.mockResolvedValue({items:[]})
 if(kind==='changed') f.selector.isCurrent.mockResolvedValueOnce(true).mockResolvedValue(false)
 await expect(f.service.tick(f.selector as any,f.routes as any,f.io as any)).rejects.toThrow()
 expect(f.cache.set).not.toHaveBeenCalled()
})
it('fills newly returned bars and confirms only remaining sub-gaps',async()=>{
 const f=fixture();await f.service.read(f.selection,'H1',f.items,step)
 const middle=f.candle('2026-09-12T00:00:00.000Z');f.io.read.mockResolvedValue({items:[f.items[0]!,middle,f.items[1]!]})
 await f.service.tick(f.selector as any,f.routes as any,f.io as any)
 expect(f.io.write.mock.calls[0]![1]).toHaveLength(3)
 expect(await f.service.read(f.selection,'H1',[f.items[0]!,middle,f.items[1]!],step)).toHaveLength(2)
 expect(unresolvedMarketGap([1,0],step,[{from,to}])).toBe(true)
})

it('splits long gaps into bounded reads and requires both endpoints across all pages',async()=>{
 const f=fixture(), minute=60000
 f.io.read.mockImplementation(async(_u:any,_a:any,_s:any,_tf:any,before:number,limit:number)=>({items:f.items.filter(i=>Date.parse(i.openTime)>=before-(limit-1)*minute&&Date.parse(i.openTime)<before)}))
 await f.service.read(f.selection,'H1',f.items,minute)
 await f.service.tick(f.selector as any,f.routes as any,f.io as any)
 expect(f.io.read.mock.calls.length).toBeGreaterThan(1)
 expect(f.io.read.mock.calls.every(c=>c[5]<=200)).toBe(true)
 expect(await f.service.read(f.selection,'H1',f.items,minute)).toEqual([{from,to}])
})
