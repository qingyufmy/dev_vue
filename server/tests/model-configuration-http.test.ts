import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { modelConfigurationRoutes } from '../src/modules/inference/transport/http/model-configuration-routes.js'
it('validates edit and verification contracts without leaking credentials',async()=>{
 const model={id:'3',name:'test',provider:'compatible',scope:'user' as const,base_url:'https://example.com/v1',protocol:'chat_completions' as const,max_tokens:1000,has_key:true,verified:false,revision:'a'.repeat(64)}
 const service={remove:vi.fn().mockResolvedValue({id:'3',deleted:true}),readAssignments:vi.fn().mockResolvedValue({analysis:null,trader:null,review:null,revision:'0'}),saveAssignments:vi.fn().mockResolvedValue({analysis:'3',trader:null,review:null,revision:'1'}),list:vi.fn().mockResolvedValue([model]),save:vi.fn().mockResolvedValue(model),verify:vi.fn().mockResolvedValue({...model,verified:true})}
 const auth={authenticate:vi.fn().mockResolvedValue({userId:7}),assertWrite:vi.fn().mockResolvedValue({userId:7})}
 const app=Fastify();await app.register(modelConfigurationRoutes,{prefix:'/api/v4',service,auth})
 try{
  expect((await app.inject('/api/v4/model-configurations')).json().data).toEqual([model])
  const request={method:'PUT' as const,url:'/api/v4/model-configurations/3',headers:{'x-csrf-token':'csrf-token-123456789','idempotency-key':'model-save-12345678'},payload:{name:'new-model',base_url:model.base_url,protocol:model.protocol,max_output_tokens:393216,expected_revision:model.revision,api_key:'private-test-key'}}
  expect((await app.inject({...request,payload:{...request.payload,owner_user_id:99}})).statusCode).toBe(400)
  expect((await app.inject({...request,headers:{'x-csrf-token':'csrf-token-123456789'}})).statusCode).toBe(400)
  expect(service.save).not.toHaveBeenCalled()
  const result=await app.inject(request);expect(result.statusCode,result.body).toBe(200);expect(result.body).not.toContain('private-test-key')
  expect(service.save).toHaveBeenCalledWith(7,'3','model-save-12345678',request.payload)
  const verified=await app.inject({method:'POST',url:'/api/v4/model-configurations/3/verification',headers:request.headers,payload:{expected_revision:model.revision}})
  const created=await app.inject({method:'POST',url:'/api/v4/model-configurations',headers:request.headers,payload:{name:'new',base_url:model.base_url,protocol:model.protocol,provider:'deepseek',scope:'user',api_key:'synthetic-key',max_output_tokens:393216}})
  expect(created.statusCode,created.body).toBe(200)
  expect((await app.inject({method:'DELETE',url:'/api/v4/model-configurations/3',headers:request.headers,payload:{expected_revision:model.revision}})).statusCode).toBe(200)
  expect((await app.inject({method:'PUT',url:'/api/v4/model-assignments',headers:request.headers,payload:{analysis:'3',trader:null,review:null,revision:'0'}})).statusCode).toBe(200)
  expect((await app.inject({method:'PUT',url:'/api/v4/model-assignments',headers:request.headers,payload:{analysis:'3',trader:null,review:null,revision:'0',user_id:99}})).statusCode).toBe(400)
  expect(verified.statusCode,verified.body).toBe(200);expect(verified.json().data.verified).toBe(true)
 }finally{await app.close()}
})
