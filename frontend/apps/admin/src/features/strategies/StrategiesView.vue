<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { createApiClient } from '@aurum/api-client'
import { strategiesResponseSchema, strategyDetailResponseSchema, type StrategySummary } from '@aurum/contracts'
import { Button } from '@aurum/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@aurum/ui/card'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@aurum/ui/alert-dialog'
import { useRoute } from 'vue-router'
import { Textarea } from '@aurum/ui/textarea'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from '@aurum/ui/sheet'
import { useAdminSession } from '~/features/auth'
const route = useRoute()
const client = createApiClient(), { session } = useAdminSession()
type Detail = Awaited<ReturnType<typeof client.getStrategy>>['data']
const items = ref<StrategySummary[]>([]), detail = ref<Detail | null>(null), selected = ref(typeof route.query.strategy_id === 'string' ? route.query.strategy_id : ''), loading = ref(false), busy = ref(false), notice = ref('')
const pending = ref<{ versionId: string; version: number; key: string } | null>(null)
const editor = ref<{ id: string; name: string; revision: number; prompt: string; config: string } | null>(null)
const editError = ref('')
let saveAttempt: { signature: string; key: string } | null = null
let autoEdit = route.query.edit === '1'
function edit() {
  const target = detail.value
  if (!target || target.status === 'retired') return
  const latest = target.versions.reduce<Detail['versions'][number] | undefined>((a, b) => !a || b.version > a.version ? b : a, undefined)
  if (!latest) return
  editor.value = { id: target.id, name: target.name, revision: target.revision, prompt: latest.promptText, config: JSON.stringify(latest.config, null, 2) }
  editError.value = ''; saveAttempt = null
}
async function saveVersion() {
  const draft = editor.value
  if (!draft || !session.value || busy.value) return
  let config: unknown
  try { config = JSON.parse(draft.config) } catch { editError.value = '配置格式不正确，请填写有效的 JSON。'; return }
  if (!config || typeof config !== 'object' || Array.isArray(config) || !draft.prompt.trim()) { editError.value = '请填写提示词，配置须为 JSON 对象。'; return }
  const body = { prompt_text: draft.prompt, config }
  const signature = JSON.stringify({ id: draft.id, revision: draft.revision, body })
  if (!saveAttempt || saveAttempt.signature !== signature) saveAttempt = { signature, key: crypto.randomUUID() }
  busy.value = true; editError.value = ''
  try {
    const result = await client.request(strategyDetailResponseSchema, `/api/v4/admin/strategies/${encodeURIComponent(draft.id)}/versions`,
      { method: 'POST', body: JSON.stringify(body), csrfToken: session.value.csrf_token, headers: { 'Content-Type': 'application/json', 'If-Match': `"${draft.revision}"`, 'Idempotency-Key': saveAttempt.key } })
    detail.value = result.data; editor.value = null; notice.value = '新版本已保存，发布后生效。'
  } catch { editError.value = '保存未完成，请检查内容后重试；若版本冲突，请关闭编辑并刷新。' }
  finally { busy.value = false }
}
const commandKey = () => crypto.randomUUID()
let generation = 0
onBeforeUnmount(() => { generation++ })
async function load() {
  notice.value = ''; detail.value = null; loading.value = true
  const request = ++generation
  try { const result = await client.request(strategiesResponseSchema, '/api/v4/admin/strategies'); if (request === generation) { items.value = result.data.items; if (!items.value.some(item => item.id === selected.value)) selected.value = items.value[0]?.id ?? ''; await open(selected.value) } }
  catch { if (request === generation) notice.value = '策略读取失败，请重试。' }
  finally { if (request === generation) loading.value = false }
}
async function open(id: string) {
  selected.value = id; detail.value = null; notice.value = ''
  const request = ++generation
  if (!id) { loading.value = false; return }
  loading.value = true
  try { const result = await client.request(strategyDetailResponseSchema, `/api/v4/admin/strategies/${encodeURIComponent(id)}`); if (request === generation) { detail.value = result.data; if (autoEdit) { autoEdit = false; edit() } } }
  catch { if (request === generation) notice.value = '策略详情读取失败，请重试。' }
  finally { if (request === generation) loading.value = false }
}
async function publish() {
  if (!pending.value || !detail.value || !session.value || busy.value) return
  const request = generation, target = detail.value, command = pending.value
  busy.value = true; notice.value = ''
  try {
    const result = await client.request(strategyDetailResponseSchema, `/api/v4/admin/strategies/${encodeURIComponent(target.id)}/versions/${encodeURIComponent(command.versionId)}/publish`,
      { method: 'POST', csrfToken: session.value.csrf_token, headers: { 'If-Match': `"${target.revision}"`, 'Idempotency-Key': command.key } })
    if (request === generation) { detail.value = result.data; pending.value = null; notice.value = '已发布，可在交易端选择此策略进行分析。' }
  } catch { if (request === generation) notice.value = '发布未确认。可重试同一次请求；若版本已变更，请关闭并刷新。' }
  finally { busy.value = false }
}
watch(() => session.value?.user.id, () => { items.value = []; pending.value = null; void load() }, { immediate: true })
</script>
<template>
  <div class="mx-auto grid max-w-6xl gap-6 p-4 md:p-6">
    <div class="flex items-center justify-between gap-4"><h1 class="text-xl font-semibold">平台策略</h1><Button variant="outline" :disabled="busy || loading" @click="load">刷新</Button></div>
    <p class="text-sm text-muted-foreground">编辑策略会保存为新版本，发布后供用户使用。发布不会打开自动分析或自动交易，也不会替换已有订阅绑定的版本。</p>
    <p v-if="notice && !pending" role="status" class="text-sm">{{ notice }}</p>
    <div class="grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <nav aria-label="平台策略列表" class="grid content-start gap-2"><Button v-for="item in items" :key="item.id" class="h-auto justify-start whitespace-normal py-3 text-left" :variant="selected === item.id ? 'secondary' : 'outline'" :disabled="busy" @click="open(item.id)">{{ item.name }} · {{ item.kind === 'analysis' ? '行情分析' : '交易执行' }}</Button></nav>
      <p v-if="loading" role="status">正在加载…</p>
      <Card v-else-if="detail" class="min-w-0">
        <CardHeader><Button class="justify-self-start" :disabled="busy || detail.status === 'retired' || !detail.versions.length" @click="edit">编辑策略</Button><CardTitle>{{ detail.name }}</CardTitle><CardDescription>{{ detail.activeVersionId ? '已有发布版本' : '尚未发布' }}</CardDescription></CardHeader>
        <CardContent class="grid gap-4">
          <section v-for="version in detail.versions" :key="version.id" class="grid gap-3 rounded-lg border p-4">
            <div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-medium">v{{ version.version }}</h2><Button :disabled="busy || detail.status === 'retired' || detail.activeVersionId === version.id" @click="pending = { versionId: version.id, version: version.version, key: commandKey() }">{{ detail.activeVersionId === version.id ? '已发布' : '发布此版本' }}</Button></div>
            <details><summary class="cursor-pointer text-sm">查看提示词与行情配置</summary><pre class="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{{ version.promptText }}
{{ JSON.stringify(version.config, null, 2) }}</pre></details>
          </section>
        </CardContent>
      </Card>
    </div>
    <Sheet :open="!!editor" @update:open="!$event && !busy && (editor = null)">
      <SheetContent class="w-full gap-0 overflow-hidden p-0 data-[side=right]:w-full sm:data-[side=right]:max-w-3xl">
        <SheetHeader class="border-b pr-16"><SheetTitle>编辑 {{ editor?.name }}</SheetTitle><SheetDescription>保存为新版本，当前生效版本保持不变。</SheetDescription></SheetHeader>
        <div v-if="editor" class="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          <label class="grid gap-2 text-sm">策略提示词<Textarea v-model="editor.prompt" :disabled="busy" class="min-h-96 font-mono text-sm" /></label>
          <details><summary class="cursor-pointer text-sm">数据配置</summary><label class="mt-3 grid gap-2 text-sm">配置 JSON<Textarea v-model="editor.config" :disabled="busy" class="min-h-64 font-mono text-sm" /></label></details>
          <p v-if="editError" role="alert" class="text-sm text-destructive">{{ editError }}</p>
        </div>
        <SheetFooter class="border-t"><Button variant="outline" :disabled="busy" @click="editor = null">取消</Button><Button :disabled="busy" @click="saveVersion">{{ busy ? '正在保存…' : '保存新版本' }}</Button></SheetFooter>
      </SheetContent>
    </Sheet>
    <AlertDialog :open="!!pending" @update:open="!$event && !busy && (pending = null)"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>发布 {{ detail?.name }} v{{ pending?.version }}？</AlertDialogTitle><AlertDialogDescription>此版本将成为平台可用版本。现有订阅与交易开关保持当前设置。</AlertDialogDescription></AlertDialogHeader><p v-if="notice" role="alert" class="text-sm text-destructive">{{ notice }}</p><AlertDialogFooter><AlertDialogCancel :disabled="busy">取消</AlertDialogCancel><Button :disabled="busy" @click="publish">{{ busy ? '正在发布…' : '确认发布' }}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>
</template>
