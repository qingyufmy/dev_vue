<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createApiClient, ApiClientError } from '@aurum/api-client'
import { modelDeletedResponseSchema, modelSelectionResponseSchema, modelConfigurationListResponseSchema, type ModelConfiguration, type ModelSelection } from '@aurum/contracts'
import { Button } from '@aurum/ui/button'
import { providerLabel } from './model-presentation'
import { useTradeSession } from '~/features/auth'
import ModelAssignments from './ModelAssignments.vue'
import {AlertDialog,AlertDialogContent,AlertDialogHeader,AlertDialogTitle,AlertDialogDescription,AlertDialogFooter,AlertDialogCancel} from '@aurum/ui/alert-dialog'
import ModelEditor from './ModelEditor.vue'
import { Settings2, CheckCircle2, RefreshCw, LoaderCircle, CircleAlert, Plus, Trash2 } from '@lucide/vue'
const configurations=ref<ModelConfiguration[]>([]), editing=ref<ModelConfiguration|null>(null), configurationError=ref('')
const models=computed(()=>{const all=new Map((state.value?.items??[]).map(item=>[item.id,item])); for(const item of configurations.value) if(!all.has(item.id)) all.set(item.id,{id:item.id,name:item.name,scope:item.scope,available:false,reason:'model_not_verified'});return [...all.values()]})
const client = createApiClient()
const { session } = useTradeSession()
const state = ref<ModelSelection | null>(null), loading = ref(false), saving = ref(false), notice = ref('')
const deleting=ref<ModelConfiguration|null>(null),deleteError=ref(''),assignmentRefresh=ref(0)
let deleteRequest:string|null=null
function add(){editing.value={id:'new',name:'',provider:'volcengine_agent_plan',scope:'user',base_url:'',protocol:'chat_completions',max_tokens:null,has_key:false,verified:false,revision:'',temperature:0.3,request_timeout_ms:180000,thinking_enabled:false,reasoning_effort:null,context_window_tokens:null,max_input_tokens:null,max_output_tokens:null}}
function confirmDelete(model:ModelConfiguration){deleting.value=model;deleteError.value='';deleteRequest=crypto.randomUUID()}
async function remove(){if(!deleting.value||saving.value||!session.value)return;const version=generation;saving.value=true;try{await client.request(modelDeletedResponseSchema,`/api/v4/model-configurations/${deleting.value.id}`,{method:'DELETE',csrfToken:session.value.csrf_token,headers:{'Idempotency-Key':deleteRequest!},body:JSON.stringify({expected_revision:deleting.value.revision})});if(version!==generation)return;deleting.value=null;saving.value=false;await load()}catch(error){if(version===generation)deleteError.value=error instanceof ApiClientError&&error.problem?.code==='model_configuration_in_use'?'此模型仍被默认设置或用途分配使用，请先更换模型。':'未能确认删除结果，请刷新核对后重试。'}finally{if(version===generation)saving.value=false}}
let generation = 0
onBeforeUnmount(() => { generation++ })
async function load() {
  const request = ++generation
  assignmentRefresh.value++; loading.value = true; notice.value = ''; state.value = null
  try { const [selection,configs] = await Promise.allSettled([client.request(modelSelectionResponseSchema, '/api/v4/model-selection'),client.request(modelConfigurationListResponseSchema, '/api/v4/model-configurations')]); if(request!==generation)return; if(selection.status==='rejected')throw selection.reason; state.value=selection.value.data; configurations.value=configs.status==='fulfilled'?configs.value.data:[]; configurationError.value=configs.status==='rejected'?'接入配置读取失败，请刷新后重试。':'' }
  catch { if (request === generation) notice.value = '暂时无法读取模型，请重试。' }
  finally { if (request === generation) loading.value = false }
}
async function select(id: string) {
  if (!state.value || saving.value || !session.value) return
  const request = generation
  saving.value = true; notice.value = ''
  try {
    const result = await client.request(modelSelectionResponseSchema, '/api/v4/model-selection', { method: 'PUT', csrfToken: session.value.csrf_token,
      body: JSON.stringify({ model_profile_id: id, expected_model_profile_id: state.value.selected_model_profile_id }) })
    if (request === generation) { state.value = result.data; notice.value = '默认模型已更新，下一次分析开始生效。' }
  } catch { if (request === generation) notice.value = '未能确认保存结果，请刷新查看当前选择后再试。' }
  finally { if (request === generation) saving.value = false }
}
watch(() => session.value?.user.id, () => { editing.value=null;deleting.value=null;configurations.value=[]; saving.value = false; void load() }, { immediate: true })
</script>
<template>
  <div class="mx-auto w-full max-w-6xl space-y-7 p-4 md:p-8">
    <header class="flex items-start justify-between gap-4">
      <div class="space-y-2"><h1 id="models-heading" tabindex="-1" class="text-2xl font-semibold tracking-tight">模型配置</h1><p class="text-sm leading-6 text-muted-foreground">管理模型接入，选择 AI 分析和交易决策使用的默认模型。</p></div>
      <div class="flex shrink-0 gap-2"><Button variant="outline" :disabled="loading || saving" @click="load"><RefreshCw class="size-4" :class="{'animate-spin motion-reduce:animate-none':loading}" />刷新</Button><Button @click="add"><Plus class="size-4" />添加模型</Button></div>
    </header>
    <p v-if="configurationError" role="alert" class="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{{configurationError}}</p>
    <p v-if="notice" role="status" class="text-sm">{{notice}}</p>
    <div v-if="loading" role="status" class="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle class="size-5 animate-spin motion-reduce:animate-none" />正在加载模型…</div>
    <section v-else-if="state" aria-label="模型列表" class="overflow-hidden rounded-xl border bg-card">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4"><h2 class="text-sm font-semibold">我的模型 <span class="ml-2 font-normal tabular-nums text-muted-foreground">{{models.length}}</span></h2><p class="text-xs text-muted-foreground">{{state.selected_model_profile_id?'切换后，下次分析生效':'当前跟随平台默认模型'}}</p></div>
      <div class="hidden grid-cols-[minmax(0,1fr)_100px_120px_240px] gap-4 border-b bg-muted/20 px-5 py-3 text-xs text-muted-foreground lg:grid"><span>模型 / 提供商</span><span>使用范围</span><span>连接状态</span><span class="text-right">操作</span></div>
      <ul class="divide-y">
        <li v-for="model in models" :key="model.id" class="grid items-center gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_100px_120px_240px]" :class="{'bg-primary/5':state.selected_model_profile_id===model.id}">
          <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h3 class="break-all text-sm font-semibold">{{model.name}}</h3><span v-if="state.selected_model_profile_id===model.id" class="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">当前默认</span></div><p class="mt-1.5 text-xs text-muted-foreground">{{providerLabel(configurations.find(item=>item.id===model.id)?.provider)}}</p></div>
          <span class="text-xs text-muted-foreground">{{model.scope==='platform'?'平台共享':'仅自己使用'}}</span>
          <div class="flex items-center gap-1.5 text-xs" :class="model.available?'text-foreground':'text-muted-foreground'"><CheckCircle2 v-if="model.available" class="size-3.5 shrink-0 text-primary" /><CircleAlert v-else class="size-3.5 shrink-0" /><span>{{model.available?'已验证':model.reason==='model_not_verified'?'待验证':'暂不可用'}}</span></div>
          <div class="flex items-center gap-2 lg:justify-end"><Button v-if="configurations.some(item=>item.id===model.id)" size="sm" variant="ghost" @click="editing=configurations.find(item=>item.id===model.id)??null"><Settings2 class="size-3.5" />编辑接入</Button><Button v-if="state.selected_model_profile_id!==model.id" size="sm" variant="outline" :disabled="saving || !model.available" @click="select(model.id)">设为默认</Button><span v-else class="inline-flex h-8 min-w-20 items-center justify-center gap-1 text-xs text-primary"><CheckCircle2 class="size-3.5" />使用中</span><Button v-if="configurations.some(item=>item.id===model.id)" variant="ghost" size="icon" class="size-8 text-muted-foreground hover:text-destructive" :aria-label="`删除 ${model.name}`" @click="confirmDelete(configurations.find(item=>item.id===model.id)!)"><Trash2 class="size-4" /></Button></div>
          <p v-if="!model.available && model.reason!=='model_not_verified'" class="text-xs text-muted-foreground lg:col-span-4">当前会员或共享设置不允许使用此模型。</p>
        </li>
      </ul>
      <p v-if="!models.length" class="px-5 py-16 text-center text-sm text-muted-foreground">还没有模型，点击“添加模型”开始配置。</p>
    </section>
    <ModelAssignments v-if="state" :models="state.items" :refresh="assignmentRefresh" />
    <p v-if="state && !loading" class="text-xs leading-5 text-muted-foreground">已开始的任务继续使用原模型。平台共享配置的修改会影响使用该模型的用户。</p>
  </div>
  <AlertDialog :open="!!deleting" @update:open="value=>{if(!value)deleting=null}"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除这个模型？</AlertDialogTitle><AlertDialogDescription>{{deleting?.name}} 将从模型列表移除，已有分析和交易记录会保留。</AlertDialogDescription></AlertDialogHeader><p v-if="deleteError" role="alert" class="text-sm text-destructive">{{deleteError}}</p><AlertDialogFooter><AlertDialogCancel :disabled="saving">取消</AlertDialogCancel><Button variant="destructive" :disabled="saving" @click="remove">{{saving?'删除中…':'确认删除'}}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  <ModelEditor :model="editing" @close="editing=null" @saved="load" />
</template>
