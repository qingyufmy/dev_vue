import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, it, vi, afterEach } from 'vitest'
import NotificationBell from './NotificationBell.vue'
import { personalInbox, soundReady } from './state'
const api = vi.hoisted(() => ({ getPersonalInbox:vi.fn(),getPersonalSettings:vi.fn(),readAllPersonalNotifications:vi.fn(),readPersonalNotification:vi.fn(),push:vi.fn(),play:vi.fn() }))
vi.mock('vue-router',()=>({useRouter:()=>({push:api.push}),NavigationFailureType:{duplicated:16},isNavigationFailure:(failure:{type:number},type:number)=>failure?.type===type}))
vi.mock('~/features/auth',()=>({useTradeSession:()=>({session:ref({user:{id:7},csrf_token:'csrf'})})}))
vi.mock('./state',()=>({personalClient:api,personalInbox:ref({items:[],unread:0}),personalSettings:ref(null),soundReady:ref(false),playNotice:api.play}))
let wrapper:ReturnType<typeof mount>|undefined
const message={id:'a',kind:'analysis',resourceId:'analysis-a',title:'行情更新',summary:'发现机会',actionable:true,createdAt:'2026-09-16T00:00:00Z',read:false}
async function setup(){
 api.getPersonalInbox.mockResolvedValue({data:{items:[{...message}],unread:87}})
 api.getPersonalSettings.mockResolvedValue({data:{preferences:{}}})
 const slot={name:'Slot',template:'<div><slot /></div>'}
 wrapper=mount(NotificationBell,{global:{stubs:{Popover:{name:'Popover',props:['open'],template:'<div><slot /></div>'},PopoverContent:slot,PopoverTrigger:slot,Sheet:slot,SheetContent:slot,SheetHeader:slot,SheetTitle:slot,SheetDescription:slot}}})
 await flushPromises();return wrapper
}
afterEach(()=>{wrapper?.unmount();vi.resetAllMocks();vi.useRealTimers();soundReady.value=false;localStorage.clear()})
it('sends one bulk request, synchronizes the badge, and disables completed bulk read',async()=>{
 const view=await setup();let finish!:(value:unknown)=>void
 api.readAllPersonalNotifications.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
 const button=view.findAll('button').find(item=>item.text()==='全部已读')!
 await button.trigger('click');await button.trigger('click')
 expect(api.readAllPersonalNotifications).toHaveBeenCalledTimes(1)
 expect(api.readAllPersonalNotifications).toHaveBeenCalledWith('csrf')
 expect(api.readPersonalNotification).not.toHaveBeenCalled()
 api.getPersonalInbox.mockResolvedValue({data:{items:[{...message,read:true}],unread:0}})
 finish({data:{read:true}});await flushPromises()
 expect(personalInbox.value.unread).toBe(0)
 expect(personalInbox.value.items[0]?.read).toBe(true)
 expect(view.find('button[aria-label="站内消息，0 条未读"]').exists()).toBe(true)
 expect(button.attributes('disabled')).toBeDefined()
})
it('preserves unread markers on failure and permits retry',async()=>{
 const view=await setup();api.readAllPersonalNotifications.mockRejectedValue(new Error('offline'))
 const button=view.findAll('button').find(item=>item.text()==='全部已读')!
 await button.trigger('click');await flushPromises()
 expect(personalInbox.value.unread).toBe(87)
 expect(personalInbox.value.items[0]?.read).toBe(false)
 expect(view.text()).toContain('全部已读未完成')
 expect(button.attributes('disabled')).toBeUndefined()
})

it.each([undefined,{type:16}])('closes the panel for successful or duplicate navigation',async failure=>{
 const view=await setup();api.push.mockResolvedValue(failure)
 const popover=view.findComponent({name:'Popover'})
 popover.vm.$emit('update:open',true);await flushPromises()
 await view.findAll('button').find(item=>item.text().includes('行情更新'))!.trigger('click');await flushPromises()
 expect(api.readPersonalNotification).toHaveBeenCalledWith('csrf','a')
 expect(api.push).toHaveBeenCalledWith({path:'/analyst',query:{analysis_id:'analysis-a'}})
 expect(popover.props('open')).toBe(false)
})
it('keeps the panel open when navigation to settings is cancelled',async()=>{
 const view=await setup();api.push.mockResolvedValue({type:4})
 const popover=view.findComponent({name:'Popover'})
 popover.vm.$emit('update:open',true);await flushPromises()
 await view.findAll('button').find(item=>item.text()==='通知设置')!.trigger('click');await flushPromises()
 expect(popover.props('open')).toBe(true)
 expect(api.readPersonalNotification).not.toHaveBeenCalled()
})
it('does not replay history and only sounds once for newly received records',async()=>{
 vi.useFakeTimers();soundReady.value=true
 vi.spyOn(document,'visibilityState','get').mockReturnValue('visible')
 api.play.mockResolvedValue(undefined)
 await setup()
 expect(api.play).not.toHaveBeenCalled()
 api.getPersonalSettings.mockResolvedValue({data:{preferences:{analysisSound:'bell',decisionSound:'chime'}}})
 api.getPersonalInbox.mockResolvedValue({data:{items:[{...message,id:'b'},{...message}],unread:88}})
 await vi.advanceTimersByTimeAsync(15000);await flushPromises()
 expect(api.play).toHaveBeenCalledTimes(1)
 expect(api.play).toHaveBeenCalledWith('bell')
 await vi.advanceTimersByTimeAsync(15000);await flushPromises()
 expect(api.play).toHaveBeenCalledTimes(1)
 vi.restoreAllMocks()
})
