<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@aurum/ui/alert-dialog'
import { Bell, UserRound, Volume2, LoaderCircle, CheckCircle2 } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
import { Input } from '@aurum/ui/input'
import { Label } from '@aurum/ui/label'
import { Switch } from '@aurum/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import type { PersonalSettings } from '@aurum/contracts'
import { useTradeSession } from '~/features/auth'
import { personalClient, personalSettings, playNotice, soundReady } from './state'
const {session,displayName}=useTradeSession(), draft=ref<PersonalSettings|null>(null), webhook=ref(''), secret=ref(''), busy=ref(false), notice=ref(''), failed=ref(false)
let requestKey = '', requestBody = ''
const channels=[{key:'analysis' as const,title:'行情分析',help:'有效信息：发现做多或做空机会'},{key:'decision' as const,title:'交易决策',help:'有效信息：包含开仓、平仓、改单等实际动作'}]
const sounds=[{value:'off',label:'静音'},{value:'bell',label:'清脆双音'},{value:'chime',label:'上行和弦'},{value:'pulse',label:'轻柔提示'}]
const loading = ref(true), baseline = ref(''), discardOpen = ref(false), previewing = ref(''), previewError = ref('')
let alive = true, leaveDecision: ((value: boolean) => void) | null = null
const dirty = computed(() => !!draft.value && (JSON.stringify(draft.value) !== baseline.value || !!webhook.value || !!secret.value))
watch(dirty, changed => { if (changed && !busy.value) { notice.value = ''; failed.value = false } })
async function load() {
  loading.value = true; notice.value = ''; failed.value = false
  try {
    const result = await personalClient.getPersonalSettings()
    if (!alive) return
    draft.value = result.data; baseline.value = JSON.stringify(result.data)
  } catch { if (alive) { failed.value = true; notice.value = '个人设置暂时无法读取，请重试。' } }
  finally { if (alive) loading.value = false }
}
onMounted(() => { void load(); window.addEventListener('beforeunload', warnUnload) })
onBeforeUnmount(() => { alive = false; leaveDecision?.(false); window.removeEventListener('beforeunload', warnUnload); webhook.value = ''; secret.value = '' })
function warnUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = '' } }
function finishLeave(leave: boolean) { discardOpen.value = false; leaveDecision?.(leave); leaveDecision = null }
onBeforeRouteLeave(() => {
  if (busy.value) return false
  if (!dirty.value) return true
  discardOpen.value = true
  return new Promise<boolean>(resolve => { leaveDecision = resolve })
})
async function save() {
  if (!draft.value || !session.value || busy.value || !dirty.value) return
  if (draft.value.preferences.feishuEnabled && !draft.value.hasFeishu && !webhook.value.trim()) {
    failed.value = true; notice.value = '请填写飞书机器人地址，或关闭飞书通知后保存。'; return
  }
  busy.value = true; notice.value = ''
  const { hasFeishu, emailAvailable, ...body } = JSON.parse(JSON.stringify(draft.value)) as PersonalSettings
  const payload = { ...body, ...(webhook.value.trim() ? { feishuWebhook: webhook.value.trim() } : {}), ...(secret.value.trim() ? { feishuSecret: secret.value.trim() } : {}) }
  try {
    const serialized = JSON.stringify(payload)
    if (serialized !== requestBody) { requestBody = serialized; requestKey = crypto.randomUUID() }
    const response = await personalClient.savePersonalSettings(session.value.csrf_token, payload, requestKey)
    if (!alive) return
    draft.value = { ...body, revision: response.data.revision, hasFeishu: hasFeishu || !!payload.feishuWebhook, emailAvailable }
    personalSettings.value = JSON.parse(JSON.stringify(draft.value)); webhook.value = ''; secret.value = ''
    baseline.value = JSON.stringify(draft.value); failed.value = false; notice.value = '设置已保存，后续消息按新设置提醒。'
  } catch { if (alive) { failed.value = true; notice.value = '保存未完成，填写内容已保留。请检查渠道配置后重试；若其它页面已修改设置，请重新加载后核对。' } }
  finally { if (alive) busy.value = false }
}
async function preview(key: string, sound: string) {
  if (sound === 'off' || previewing.value) return
  previewing.value = key; previewError.value = ''
  try { await playNotice(sound); await new Promise(resolve => setTimeout(resolve, 650)) }
  catch { if (alive) previewError.value = '浏览器暂时无法播放声音，请检查此网站的声音权限。' }
  finally { if (alive) previewing.value = '' }
}
</script>
<template>
  <div class="mx-auto grid max-w-4xl gap-6 p-5 sm:p-6">
    <header><h1 class="text-2xl font-semibold">个人设置</h1><p class="mt-2 text-sm text-muted-foreground">管理个人称呼、消息推送与网页声音提醒。</p></header>
    <div v-if="loading" role="status" class="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" />正在读取个人设置…</div>
    <div v-else-if="!draft" role="alert" class="grid justify-items-start gap-3 rounded-xl border p-5"><p>{{ notice }}</p><Button variant="outline" @click="load">重新加载</Button></div>
    <template v-if="draft && !loading">
      <fieldset :disabled="busy" :aria-busy="busy" class="grid min-w-0 gap-6">
      <section class="rounded-xl border bg-card p-5"><h2 class="mb-5 flex items-center gap-2 font-semibold"><UserRound class="size-4 text-primary" />个人信息</h2><Label for="personal-name">个人称呼</Label><Input id="personal-name" v-model="draft.nickname" class="mt-2 max-w-sm" :placeholder="displayName" :maxlength="80" /><p class="mt-2 text-xs text-muted-foreground">用于交易端展示，不更改登录账号。</p></section>
      <section class="rounded-xl border bg-card p-5"><h2 class="mb-5 flex items-center gap-2 font-semibold"><Bell class="size-4 text-primary" />通知内容</h2>
        <div v-for="channel in channels" :key="channel.key" class="flex flex-wrap items-center justify-between gap-4 border-t py-4"><div><h3 class="text-sm font-medium">{{ channel.title }}</h3><p class="mt-1 text-xs text-muted-foreground">{{ channel.help }}</p></div><Select :disabled="busy" v-model="draft.preferences[channel.key]"><SelectTrigger class="w-40" :aria-label="`${channel.title}推送范围`"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部推送</SelectItem><SelectItem value="effective">仅有效信息</SelectItem><SelectItem value="off">不推送</SelectItem></SelectContent></Select></div>
        <p class="text-xs text-muted-foreground">范围设置同时应用于站内信及已开启的外部渠道，新设置从后续记录生效。</p>
      </section>
      <section class="rounded-xl border bg-card p-5"><h2 class="mb-5 font-semibold">外部通知渠道</h2><div class="flex items-center justify-between"><Label for="feishu-enable">飞书机器人</Label><Switch :disabled="busy" id="feishu-enable" v-model="draft.preferences.feishuEnabled" /></div>
        <div v-if="draft.preferences.feishuEnabled" class="mt-4 grid gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"><Label for="feishu-hook">机器人 Webhook</Label><Input id="feishu-hook" v-model="webhook" type="password" autocomplete="off" :placeholder="draft.hasFeishu?'已配置，留空保留':'填写飞书群机器人的 Webhook 地址'" /><Label for="feishu-secret">签名密钥（选填）</Label><Input id="feishu-secret" v-model="secret" type="password" autocomplete="off" placeholder="机器人启用签名校验时填写，留空保留" /></div>
        <div class="mt-6 flex items-center justify-between border-t pt-4"><div><Label for="email-enable">邮件通知</Label><p class="mt-1 text-xs text-muted-foreground">{{ draft.emailAvailable ? '发送至登录账户的邮箱，由平台邮件服务发送。' : '平台尚未配置邮件服务，配置完成后可开启。' }}</p></div><Switch :disabled="busy || !draft.emailAvailable" id="email-enable" v-model="draft.preferences.emailEnabled" /></div>
      </section>
      <section class="rounded-xl border bg-card p-5"><h2 class="mb-3 flex items-center gap-2 font-semibold"><Volume2 class="size-4 text-primary" />网页声音提醒</h2><p class="mb-4 text-xs leading-6 text-muted-foreground">点击试听以启用当前页面声音。仅新消息提醒，历史记录不响铃；浏览器后台可能暂停声音。</p>
        <div v-for="channel in channels" :key="channel.key" class="flex flex-wrap items-center gap-3 border-t py-4"><span class="mr-auto text-sm">{{ channel.title }}</span><Select :disabled="busy" v-model="draft.preferences[channel.key==='analysis'?'analysisSound':'decisionSound']"><SelectTrigger class="w-36" :aria-label="`${channel.title}声音`"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="sound in sounds" :key="sound.value" :value="sound.value">{{ sound.label }}</SelectItem></SelectContent></Select><Button variant="outline" :disabled="busy || !!previewing || draft.preferences[channel.key==='analysis'?'analysisSound':'decisionSound']==='off'" :aria-label="`试听${channel.title}声音`" @click="preview(channel.key,draft.preferences[channel.key==='analysis'?'analysisSound':'decisionSound'])"><Volume2 class="size-4" :class="{'motion-safe:animate-pulse':previewing===channel.key}" />{{ previewing===channel.key?'播放中…':'试听' }}</Button></div>
        <p v-if="previewError" role="alert" class="mb-2 text-sm text-destructive">{{previewError}}</p>
        <p role="status" class="text-xs text-muted-foreground">{{ soundReady?'当前页面声音已启用':'当前页面声音尚未启用' }}</p>
      </section>
      </fieldset>
      <div class="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-background px-1 py-4">
        <p :role="failed?'alert':'status'" class="min-w-0 flex-1 text-sm" :class="failed?'text-destructive':'text-muted-foreground'">{{ notice || (dirty?'有未保存的修改':'设置已同步') }}</p>
        <Button :disabled="busy || !dirty" :aria-busy="busy" @click="save"><LoaderCircle v-if="busy" class="size-4 animate-spin motion-reduce:animate-none" /><CheckCircle2 v-else-if="!dirty" class="size-4" />{{ busy?'正在保存…':dirty?'保存设置':'已保存' }}</Button>
      </div>
    </template>
  </div>
  <AlertDialog :open="discardOpen" @update:open="!$event && finishLeave(false)"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>放弃未保存的设置？</AlertDialogTitle><AlertDialogDescription>离开后，本次修改将丢失。已保存的个人信息和通知设置不受影响。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>继续编辑</AlertDialogCancel><Button variant="destructive" @click="finishLeave(true)">放弃修改并离开</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
</template>
