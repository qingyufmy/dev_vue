import { expect,it,vi } from 'vitest'
import { mount,flushPromises } from '@vue/test-utils'
import { createMemoryHistory,createRouter,RouterView } from 'vue-router'
import SystemSettingsView from '../src/features/settings/SystemSettingsView.vue'
import { settingChoices } from '../src/features/settings/setting-catalog'
const mocks=vi.hoisted(()=>({get:vi.fn(),update:vi.fn()}))
vi.mock('@aurum/api-client',async original=>({...await original<typeof import('@aurum/api-client')>(),createApiClient:()=>({getAdminSetting:mocks.get,updateAdminSetting:mocks.update})}))
vi.mock('../src/features/auth',async()=>{const {ref}=await import('vue');return {useAdminSession:()=>({session:ref({user:{id:'1'},csrf_token:'csrf'})})}})
const meta={request_id:'r',generated_at:'2026-09-07T00:00:00.000Z'}
const response={data:{setting_id:'1',namespace:'smtp',key:'port',value_type:'integer',sensitivity:'restricted',protected:false,value_state:'text',value:'465',revision:'1'},meta}
async function fixture(){const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:SystemSettingsView},{path:'/other',component:{template:'<p>other</p>'}}]});await router.push('/');await router.isReady();const wrapper=mount(RouterView,{global:{plugins:[router]}});await flushPromises();return {wrapper,router}}
it('shows actual values and validates integer range before saving',async()=>{
 mocks.get.mockReset().mockResolvedValue(response);mocks.update.mockReset()
 const {wrapper}=await fixture();try {
  expect(mocks.get).toHaveBeenCalledWith({namespace:'smtp',key:'port'});expect(wrapper.text()).toContain('当前版本 1')
  await wrapper.get('#setting-value').setValue('70000');expect(wrapper.text()).toContain('允许范围：1—65535')
  expect(wrapper.findAll('button').find(b=>b.text()==='保存修改')!.attributes('disabled')).toBeDefined()
  expect(mocks.update).not.toHaveBeenCalled()
 }finally{wrapper.unmount()}
})
it('keeps an uncertain write recoverable and blocks route leave',async()=>{
 mocks.get.mockReset().mockResolvedValue(response);mocks.update.mockReset().mockRejectedValueOnce(Error('network')).mockResolvedValueOnce({data:{setting_id:'1',revision:'2',replayed:true},meta})
 const {wrapper,router}=await fixture();try {
  await wrapper.get('#setting-value').setValue('587');await wrapper.findAll('button').find(b=>b.text()==='保存修改')!.trigger('click');await flushPromises()
  expect(wrapper.text()).toContain('确认保存结果');await router.push('/other');expect(router.currentRoute.value.path).toBe('/')
  mocks.get.mockResolvedValueOnce({data:{...response.data,value:'587',revision:'2'},meta})
  await wrapper.findAll('button').find(b=>b.text()==='确认保存结果')!.trigger('click');await flushPromises()
  expect(mocks.update.mock.calls[1]![1]).toBe(mocks.update.mock.calls[0]![1]);expect(wrapper.text()).toContain('保存已确认')
 }finally{wrapper.unmount()}
})
it('catalog exposes all classified keys with distinct Chinese labels',()=>{
 expect(settingChoices).toHaveLength(59);expect(new Set(settingChoices.map(x=>x.namespace+'/'+x.key)).size).toBe(59)
 expect(settingChoices.every(x=>/[一-龥]/.test(x.label))).toBe(true)
 expect(settingChoices.filter(x=>x.type==='credential').every(x=>!x.editable)).toBe(true)
})
