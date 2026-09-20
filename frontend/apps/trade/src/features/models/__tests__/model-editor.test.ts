import { mount,flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { expect,it,vi,afterEach } from 'vitest'
import ModelEditor from '../ModelEditor.vue'
vi.mock('vue-router',()=>({onBeforeRouteLeave:vi.fn()}))
const api=vi.hoisted(()=>({request:vi.fn()}))
vi.mock('@aurum/api-client',async importOriginal=>({...await importOriginal<any>(),createApiClient:()=>api}))
vi.mock('~/features/auth',()=>({useTradeSession:()=>({session:ref({user:{id:7},csrf_token:'csrf'})})}))
const model={id:'3',name:'old',provider:'compatible',scope:'user' as const,base_url:'https://example.com/v1',protocol:'chat_completions' as const,max_tokens:2000,max_output_tokens:393216,has_key:true,verified:true,revision:'a'.repeat(64)}
let wrapper:ReturnType<typeof mount>|undefined
function setup(){wrapper=mount(ModelEditor,{props:{model},global:{stubs:{Dialog:{props:['open'],template:'<div v-if="open"><slot /></div>'},DialogContent:{template:'<div><slot /></div>'},DialogTitle:{template:'<h2><slot /></h2>'},DialogDescription:{template:'<p><slot /></p>'}}}});return wrapper}
afterEach(()=>{wrapper?.unmount();vi.clearAllMocks()})
it('saves edits without transmitting a blank key',async()=>{
 api.request.mockResolvedValue({data:{...model,name:'new',verified:false,revision:'b'.repeat(64)}})
 const view=setup();await view.get('#model-name').setValue('new')
 await view.findAll('button').find(b=>b.text()==='保存配置')!.trigger('click');await flushPromises()
 const request=api.request.mock.calls[0]![2]
 expect(JSON.parse(request.body)).toMatchObject({name:'new',expected_revision:model.revision});expect(JSON.parse(request.body)).not.toHaveProperty('api_key');expect(JSON.parse(request.body)).not.toHaveProperty('max_tokens');expect(JSON.parse(request.body).max_output_tokens).toBe(393216)
 expect(view.text()).toContain('配置已保存，请验证连接后使用');expect(view.emitted('close')).toBeUndefined()
})
it('rejects unsaved verification and invalid endpoints locally',async()=>{
 const view=setup();await view.get('#model-base').setValue('http://example.com')
 await view.findAll('button').find(b=>b.text()==='保存配置')!.trigger('click');await flushPromises();expect(api.request).not.toHaveBeenCalled()
 await view.findAll('button').find(b=>b.text()==='验证连接')!.trigger('click');expect(view.text()).toContain('请先保存修改');expect(api.request).not.toHaveBeenCalled()
})
it('clears entered credentials on close',async()=>{
 const view=setup();await view.get('#model-key').setValue('temporary-secret');await view.setProps({model:null})
 expect(view.find('#model-key').exists()).toBe(false)
 await view.setProps({model});expect((view.get('#model-key').element as HTMLInputElement).value).toBe('')
})

it('fills documented DeepSeek capacities as the single request output limit',async()=>{
 const view=setup();await view.setProps({model:{...model,name:'ark-code-latest',max_output_tokens:null}})
 expect((view.get('#context_window_tokens').element as HTMLInputElement).value).toBe('1048576')
 expect((view.get('#max_input_tokens').element as HTMLInputElement).value).toBe('1048576')
 expect((view.get('#max_output_tokens').element as HTMLInputElement).value).toBe('393216')
 expect(view.find('#model-output').exists()).toBe(false)
 await view.findAll('button').find(b=>b.text()==='验证连接')!.trigger('click')
 expect(view.text()).toContain('请先保存修改');expect(api.request).not.toHaveBeenCalled()
})
it('sends capability values and converts seconds to milliseconds',async()=>{
 api.request.mockResolvedValue({data:model});const view=setup()
 await view.get('#temperature').setValue('0.4');await view.get('#timeout').setValue('180')
 await view.findAll('button').find(b=>b.text()==='保存配置')!.trigger('click');await flushPromises()
 expect(JSON.parse(api.request.mock.calls[0]![2].body)).toMatchObject({temperature:0.4,request_timeout_ms:180000})
})

it('creates a model with provider and scope without an edit revision',async()=>{
 api.request.mockResolvedValue({data:{...model,id:'8'}});const view=setup();await view.setProps({model:{...model,id:'new',name:'deepseek-v4-pro',provider:'deepseek',max_output_tokens:393216}})
 await view.get('#model-key').setValue('synthetic-new-key')
 await view.findAll('button').find(b=>b.text()==='保存配置')!.trigger('click');await flushPromises()
 const call=api.request.mock.calls[0]!;expect(call[1]).toBe('/api/v4/model-configurations');expect(call[2].method).toBe('POST')
 const body=JSON.parse(call[2].body);expect(body).toMatchObject({provider:'deepseek',scope:'user'});expect(body).not.toHaveProperty('expected_revision')
 expect((view.get('#model-key').element as HTMLInputElement).value).toBe('')
})

it('only asks to discard when the editor contains unsaved changes',async()=>{
 const view=setup()
 await view.findAll('button').find(b=>b.text()==='关闭')!.trigger('click')
 expect(view.emitted('close')).toHaveLength(1)
 await view.get('#model-name').setValue('unsaved-name')
 await view.findAll('button').find(b=>b.text()==='关闭')!.trigger('click')
 await flushPromises()
 expect(view.emitted('close')).toHaveLength(1)
 expect(document.body.textContent).toContain('放弃未保存的修改')
 expect((view.get('#model-name').element as HTMLInputElement).value).toBe('unsaved-name')
})
