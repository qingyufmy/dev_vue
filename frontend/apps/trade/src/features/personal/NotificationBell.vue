<script setup lang="ts">
import { Bell, Check, Settings2, CheckCheck, LoaderCircle } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@aurum/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@aurum/ui/sheet'
import { onBeforeUnmount, ref, watch } from 'vue'
import { useRouter, isNavigationFailure, NavigationFailureType } from 'vue-router'
import { notificationText } from './notification-text'
import { useTradeSession } from '~/features/auth'
import { personalClient, personalInbox, personalSettings, playNotice, soundReady } from './state'
const { session } = useTradeSession(), router = useRouter(), open = ref(false), error = ref('')
const previewOpen = ref(false), markingAll = ref(false), visiting = ref(''), status = ref('')
let readVersion = 0
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined
watch(() => session.value?.user.id, async userId => {
  const scope = ++generation
  markingAll.value=false;visiting.value='';status.value='';error.value='';open.value=false;previewOpen.value=false
  if(timer) clearTimeout(timer)
  personalInbox.value={items:[],unread:0};personalSettings.value=null
  if(!userId) return
  let initialized=false, known=new Set<string>()
  async function refresh() {
    const version = readVersion
    try {
      const [inbox,settings]=await Promise.all([personalClient.getPersonalInbox(),personalClient.getPersonalSettings()])
      if(scope!==generation || version!==readVersion || markingAll.value || visiting.value)return
      personalSettings.value=settings.data;personalInbox.value=inbox.data;error.value=''
      const fresh=inbox.data.items.filter(item=>!known.has(item.id)&&!item.read)
      if(initialized && soundReady.value && document.visibilityState==='visible') {
        for(const kind of ['analysis','decision'] as const) {
          const item=fresh.find(item=>item.kind===kind)
          if(!item)continue
          const key=`aurum-sound:${userId}:${kind}`
          const notify = async () => {
            if(scope!==generation)return
            try { if(localStorage.getItem(key)===item.id)return;localStorage.setItem(key,item.id) } catch { /* Storage is optional. */ }
            await playNotice(settings.data.preferences[kind==='analysis'?'analysisSound':'decisionSound'])
          }
          if(navigator.locks) void navigator.locks.request(key,notify).catch(()=>{})
          else void notify().catch(()=>{})
        }
      }
      known=new Set(inbox.data.items.map(item=>item.id));initialized=true
    } catch { if(scope===generation)error.value='消息暂时无法读取' }
    finally {if(scope===generation)timer=setTimeout(refresh,15000)}
  }
  await refresh()
},{immediate:true})
onBeforeUnmount(()=>{generation++;if(timer)clearTimeout(timer)})
async function markAllRead() {
  if (!session.value || markingAll.value || visiting.value || !personalInbox.value.unread) return
  const scope = generation
  markingAll.value = true; error.value = ''; status.value = ''; readVersion++
  try {
    await personalClient.readAllPersonalNotifications(session.value.csrf_token)
    if (scope !== generation) return
    personalInbox.value = { items: personalInbox.value.items.map(item => ({ ...item, read: true })), unread: 0 }
    status.value = '全部消息已标记为已读'
    try {
      const inbox = await personalClient.getPersonalInbox()
      if (scope === generation) personalInbox.value = inbox.data
    } catch { if (scope === generation) status.value = '全部已读已保存，最新消息稍后同步。' }
  } catch { if (scope === generation) error.value = '全部已读未完成，请重试。' }
  finally { if (scope === generation) { markingAll.value = false; readVersion++ } }
}
async function settings() {
  if (visiting.value || markingAll.value) return
  const scope = generation
  visiting.value = 'settings'; error.value = ''
  try {
    const failure = await router.push('/settings/personal')
    if (scope === generation && (!failure || isNavigationFailure(failure, NavigationFailureType.duplicated))) {
      open.value = false; previewOpen.value = false
    }
  } catch { if (scope === generation) error.value = '通知设置暂时无法打开，请重试。' }
  finally { if (scope === generation) visiting.value = '' }
}
async function visit(item: typeof personalInbox.value.items[number]) {
  if (!session.value || visiting.value || markingAll.value) return
  const scope = generation
  visiting.value = item.id; error.value = ''; status.value = ''; readVersion++
  try {
    if (!item.read) await personalClient.readPersonalNotification(session.value.csrf_token,item.id)
    if (scope !== generation) return
    const current = personalInbox.value.items.find(message => message.id === item.id)
    if (current && !current.read) { current.read = true; personalInbox.value.unread = Math.max(0,personalInbox.value.unread-1) }
    const failure = await router.push({path:item.kind==='analysis'?'/analyst':'/trader',query:{[item.kind==='analysis'?'analysis_id':'decision_id']:item.resourceId}})
    if (scope !== generation) return
    if (!failure || isNavigationFailure(failure, NavigationFailureType.duplicated)) { open.value=false; previewOpen.value=false }
  } catch { if (scope === generation) error.value='消息打开未完成，请重试。' }
  finally { if (scope === generation) { visiting.value=''; readVersion++ } }
}
</script>
<template>
  <Popover v-model:open="previewOpen">
    <PopoverTrigger as-child><Button variant="ghost" size="icon" class="relative size-10 shrink-0" :aria-label="`站内消息，${personalInbox.unread} 条未读`"><Bell class="size-4" /><span v-if="personalInbox.unread" class="absolute -right-0.5 top-0 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white">{{ personalInbox.unread>99?'99+':personalInbox.unread }}</span></Button></PopoverTrigger>
    <PopoverContent align="end" class="w-96 max-w-[calc(100vw-2rem)] p-0" aria-label="最近消息">
      <div class="flex items-center justify-between border-b p-4"><h2 class="text-sm font-semibold">最近消息</h2><Button variant="ghost" size="sm" :disabled="!personalInbox.unread || markingAll || !!visiting" :aria-busy="markingAll" @click="markAllRead"><LoaderCircle v-if="markingAll" class="size-4 animate-spin motion-reduce:animate-none" /><CheckCheck v-else class="size-4" />{{markingAll?'处理中…':'全部已读'}}</Button></div>
      <p v-if="status" role="status" class="px-4 pt-3 text-xs text-muted-foreground">{{ status }}</p>
      <p v-if="error" role="alert" class="p-4 text-sm text-destructive">{{ error }}</p>
      <p v-else-if="!personalInbox.items.length" class="p-6 text-center text-sm text-muted-foreground">暂无新消息</p>
      <div class="max-h-[min(55svh,24rem)] overflow-y-auto">
        <button v-for="item in personalInbox.items.slice(0,3)" :key="item.id" class="block w-full border-b p-4 text-left transition-colors motion-reduce:transition-none hover:bg-muted focus-visible:outline focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60" :disabled="markingAll || !!visiting" :aria-busy="visiting===item.id" @click="visit(item)">
          <div class="flex items-center gap-2"><LoaderCircle v-if="visiting===item.id" class="size-3 shrink-0 animate-spin motion-reduce:animate-none" /><span v-else-if="!item.read" class="size-2 shrink-0 rounded-full bg-destructive" /><span class="text-sm font-medium">{{ item.title }}</span><span class="sr-only">{{ item.read ? '已读' : '未读' }}</span></div>
          <p class="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{{ notificationText(item.summary) }}</p>
          <time class="mt-2 block text-xs text-muted-foreground">{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</time>
        </button>
      </div>
      <div class="flex justify-between gap-2 p-2"><Button variant="ghost" size="sm" :disabled="!!visiting || markingAll" @click="settings">通知设置</Button><Button variant="ghost" size="sm" @click="previewOpen=false;open=true">更多消息</Button></div>
    </PopoverContent>
  </Popover>
  <Sheet v-model:open="open"><SheetContent class="flex w-full flex-col sm:max-w-md"><SheetHeader><SheetTitle>站内消息</SheetTitle><SheetDescription>行情分析与账户交易决策的新消息</SheetDescription></SheetHeader>
    <div class="flex items-center justify-between px-5"><span class="text-xs text-muted-foreground">{{ personalInbox.unread }} 条未读</span><Button variant="ghost" size="sm" :disabled="!personalInbox.unread || markingAll || !!visiting" :aria-busy="markingAll" @click="markAllRead"><LoaderCircle v-if="markingAll" class="size-4 animate-spin motion-reduce:animate-none" /><CheckCheck v-else class="size-4" />{{markingAll?'处理中…':'全部已读'}}</Button><Button variant="ghost" size="sm" :disabled="!!visiting || markingAll" @click="settings"><Settings2 class="size-4" />通知设置</Button></div>
    <p v-if="status" role="status" class="px-5 text-xs text-muted-foreground">{{ status }}</p>
    <p v-if="error" role="alert" class="px-5 text-sm text-destructive">{{ error }}</p>
    <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-5"><p v-if="!personalInbox.items.length" class="py-12 text-center text-sm text-muted-foreground">暂无消息，新记录生成后会显示在这里。</p>
      <button v-for="item in personalInbox.items" :key="item.id" class="mb-2 w-full rounded-lg border p-4 text-left transition-colors motion-reduce:transition-none hover:bg-muted focus-visible:outline focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60" :disabled="markingAll || !!visiting" :aria-busy="visiting===item.id" @click="visit(item)"><div class="flex items-center gap-2"><LoaderCircle v-if="visiting===item.id" class="size-3 shrink-0 animate-spin motion-reduce:animate-none" /><span v-else-if="!item.read" class="size-2 rounded-full bg-destructive" /><Check v-else class="size-3 text-muted-foreground" /><span class="text-sm font-medium">{{ item.title }}</span></div><p class="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">{{ notificationText(item.summary) }}</p><time class="mt-2 block text-xs text-muted-foreground">{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</time></button>
    </div>
  </SheetContent></Sheet>
</template>
