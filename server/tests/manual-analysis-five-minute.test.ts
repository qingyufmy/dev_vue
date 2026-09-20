import {it,expect} from 'vitest'
import {InferenceService} from '../src/modules/inference/application/inference-service.js'
it('enqueues manual analysis with a user-wide five minute cooldown',async()=>{
 let queued:any
 const service=new InferenceService({async queueAnalysis(input:any){queued=input;return input}} as never,{async requireActiveVersion(){return {id:'v1'}}} as never)
 await service.requestManualAnalysis(1,'s1','XAUUSD','request-key-123456',new Date('2026-09-15T04:00:00Z'))
 expect(queued).toMatchObject({userId:1,trigger:'manual',manualCooldownSeconds:300,requestedAt:'2026-09-15T04:00:00.000Z'})
})
