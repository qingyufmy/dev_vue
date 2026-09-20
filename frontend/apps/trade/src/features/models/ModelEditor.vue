<script setup lang="ts">
import { computed, ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { createApiClient, ApiClientError } from '@aurum/api-client'
import { modelConfigurationResponseSchema, type ModelConfiguration } from '@aurum/contracts'
import { useTradeSession } from '~/features/auth'
import { Button } from '@aurum/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@aurum/ui/dialog'
import { Switch } from '@aurum/ui/switch'
import { Input } from '@aurum/ui/input'
import { Label } from '@aurum/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@aurum/ui/alert-dialog'
import { onBeforeRouteLeave } from 'vue-router'
import { providerLabel } from './model-presentation'
import { LoaderCircle, CheckCircle2 } from '@lucide/vue'
const props=defineProps<{model:ModelConfiguration|null}>()
const emit=defineEmits<{close:[];saved:[]}>()
const client=createApiClient(), {session}=useTradeSession()
const current=ref<ModelConfiguration|null>(null), busy=ref(false), error=ref(''), notice=ref('')
const capabilities=reactive({temperature:'',context_window_tokens:'',max_input_tokens:'',max_output_tokens:'',request_timeout_ms:'',thinking_enabled:false,reasoning_effort:'default'})
function readCapabilities(model:ModelConfiguration){for(const key of ['temperature','context_window_tokens','max_input_tokens','max_output_tokens','request_timeout_ms'] as const)capabilities[key]=model[key]==null?'':String(key==='request_timeout_ms'?model[key]!/1000:model[key]);capabilities.thinking_enabled=model.thinking_enabled??false;capabilities.reasoning_effort=model.reasoning_effort??'default'}
const savedCapabilities=ref('')
const savedForm=ref(''), discardOpen=ref(false)
let leaveDecision: ((value:boolean)=>void) | null = null
const fingerprint=()=>JSON.stringify({form:{...form},capabilities:{...capabilities}})
const dirty=computed(()=>!!current.value && fingerprint()!==savedForm.value)
function requestClose(){if(busy.value)return;if(dirty.value)discardOpen.value=true;else emit('close')}
function finishDiscard(discard:boolean){discardOpen.value=false;if(leaveDecision){leaveDecision(discard);leaveDecision=null}else if(discard)emit('close')}
onBeforeRouteLeave(()=>{if(busy.value)return false;if(!dirty.value)return true;discardOpen.value=true;return new Promise<boolean>(resolve=>{leaveDecision=resolve})})
const deepseekCapacity=computed(()=>form.name.trim()==='ark-code-latest' || /^deepseek-v4(?:[.-]|$)/i.test(form.name.trim()))
function fillOfficialCapacity(){Object.assign(capabilities,{context_window_tokens:'1048576',max_input_tokens:'1048576',max_output_tokens:'393216'})}
const form=reactive({name:'',base:'',key:'',protocol:'chat_completions',provider:'volcengine_agent_plan',scope:'user'})
let generation=0, pending:{body:string;key:string}|null=null
watch(()=>props.model, model=>{discardOpen.value=false;leaveDecision?.(false);leaveDecision=null;generation++;pending=null;busy.value=false;error.value='';notice.value='';current.value=model
 if(model) readCapabilities(model)
 if(model) Object.assign(form,{name:model.name,base:model.base_url,key:'',protocol:model.protocol,provider:model.provider,scope:model.scope})
 else form.key=''
 savedCapabilities.value=JSON.stringify(capabilities)
 if(model && deepseekCapacity.value && !model.context_window_tokens && !model.max_input_tokens && !model.max_output_tokens)fillOfficialCapacity()
 savedForm.value=fingerprint()
},{immediate:true})
function warnUnload(event:BeforeUnloadEvent){if(dirty.value||busy.value){event.preventDefault();event.returnValue=''}}
onMounted(()=>window.addEventListener('beforeunload',warnUnload))
onBeforeUnmount(()=>{window.removeEventListener('beforeunload',warnUnload);leaveDecision?.(false);leaveDecision=null;generation++;form.key='';pending=null})
watch(()=>session.value?.user.id,()=>{generation++;form.key='';pending=null;emit('close')})
function message(reason:unknown) {
 if(reason instanceof ApiClientError) {
  if(reason.problem?.code==='model_configuration_probe_failed') return '连接验证未通过，请检查地址、密钥、模型名称和接口协议，然后重试。'
  if(reason.problem?.code==='model_configuration_new_key_required') return '更换接入地址时，请重新输入对应的密钥。'
  if(reason.status===403) return '你没有编辑此模型的权限。'
  if(reason.status===409) return '配置已被修改，请关闭编辑面板并刷新后再试。'
  if(reason.status===422 || reason.status===400) return '配置格式不正确，请检查填写内容。'
 }
 return '未能确认操作结果，请刷新配置核对后再试。'
}
async function save() {
 if(!current.value || !session.value || busy.value) return
 let url:URL
 try{url=new URL(form.base.trim())}catch{error.value='请输入完整的 HTTPS 接入地址。';return}
 if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash){error.value='接入地址需要使用 HTTPS，不能包含密钥、查询参数或登录信息。';return}
 const max=Number(capabilities.max_output_tokens)
 if(!form.name.trim() || (!Number.isInteger(max)||max<1||max>2147483647)){error.value='请输入模型名称，并填写模型的最大输出容量。';return}
 const extra=Object.fromEntries(Object.entries(capabilities).map(([key,value])=>[key,key==='thinking_enabled'?value:key==='reasoning_effort'?(value==='default'?null:value):value===''?null:Number(value)*(key==='request_timeout_ms'?1000:1)]))
 if(Object.values(extra).some(value=>typeof value==='number'&&!Number.isFinite(value))){error.value='请填写有效的模型参数。';return}
 const body=JSON.stringify({name:form.name.trim(),base_url:form.base.trim(),protocol:form.protocol,...(current.value.id==='new'?{provider:form.provider,scope:form.scope}:{expected_revision:current.value.revision}),...extra,...(form.key.trim()?{api_key:form.key.trim()}:{})})
 if(!pending || pending.body!==body) pending={body,key:crypto.randomUUID()}
 const version=generation;busy.value=true;error.value='';notice.value=''
 try {
  const result=await client.request(modelConfigurationResponseSchema,current.value.id==='new'?'/api/v4/model-configurations':`/api/v4/model-configurations/${current.value.id}`,{method:current.value.id==='new'?'POST':'PUT',csrfToken:session.value.csrf_token,headers:{'Idempotency-Key':pending.key},body:pending.body})
  if(version!==generation)return
  current.value=result.data;readCapabilities(result.data);Object.assign(form,{name:result.data.name,base:result.data.base_url,key:'',protocol:result.data.protocol});pending=null;savedCapabilities.value=JSON.stringify(capabilities);savedForm.value=fingerprint();notice.value=result.data.verified?'配置已保存。':'配置已保存，请验证连接后使用。';emit('saved')
 }catch(reason){if(version===generation)error.value=message(reason)}finally{if(version===generation)busy.value=false}
}
async function verify() {
 if(!current.value||!session.value||busy.value)return
 if(current.value.id==='new'){error.value='请先保存模型，再验证连接。';return}
 if(JSON.stringify(capabilities)!==savedCapabilities.value || form.key || form.name!==current.value.name || form.base!==current.value.base_url || form.protocol!==current.value.protocol){error.value='请先保存修改，再验证连接。';return}
 const version=generation;busy.value=true;error.value='';notice.value=''
 try{const result=await client.request(modelConfigurationResponseSchema,`/api/v4/model-configurations/${current.value.id}/verification`,{method:'POST',csrfToken:session.value.csrf_token,headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({expected_revision:current.value.revision})})
  if(version!==generation)return
  current.value=result.data;notice.value='连接验证通过，可以使用此模型。';emit('saved')
 }catch(reason){if(version===generation)error.value=message(reason)}finally{if(version===generation)busy.value=false}
}
</script>
<template>
 <Dialog :open="!!model" @update:open="!$event && requestClose()">
  <DialogContent :show-close-button="!busy" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
   <DialogHeader class="shrink-0 gap-2 border-b px-6 py-5 pr-12 text-left"><DialogTitle class="text-xl font-semibold">{{current?.id==='new'?'添加模型':'编辑模型接入'}}</DialogTitle><DialogDescription>{{form.scope==='platform'?'平台共享配置 · 修改会影响使用此模型的用户':'个人配置 · 仅你自己可以使用'}}</DialogDescription><span class="mt-1 w-fit rounded-md bg-muted px-2.5 py-1 text-xs text-foreground">{{providerLabel(form.provider)}}</span></DialogHeader>
   <form id="model-editor-form" class="grid min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-6" @submit.prevent="save">
    <fieldset :disabled="busy" class="grid min-w-0 gap-8 lg:grid-cols-2">
     <section aria-labelledby="model-connection-title" class="space-y-4">
      <h2 id="model-connection-title" class="text-sm font-semibold">接入配置</h2>
      <div v-if="current?.id==='new'" class="grid gap-4 sm:grid-cols-2"><div class="grid gap-2"><Label for="model-provider">提供商</Label><Select v-model="form.provider"><SelectTrigger id="model-provider" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="volcengine_agent_plan">火山方舟</SelectItem><SelectItem value="deepseek">DeepSeek</SelectItem><SelectItem value="openai_compatible">兼容 OpenAI 接口</SelectItem></SelectContent></Select></div><div v-if="session?.permissions?.includes('admin')" class="grid gap-2"><Label for="model-scope">使用范围</Label><Select v-model="form.scope"><SelectTrigger id="model-scope" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">仅自己使用</SelectItem><SelectItem value="platform">平台共享</SelectItem></SelectContent></Select></div></div>
      <div class="grid gap-4 sm:grid-cols-2"><div class="grid content-start gap-2"><Label for="model-name">模型名称</Label><Input id="model-name" v-model="form.name" maxlength="191" placeholder="填写服务商提供的模型名称" /></div><div class="grid content-start gap-2"><Label for="model-protocol">接口协议</Label><Select v-model="form.protocol" :disabled="busy"><SelectTrigger class="w-full" id="model-protocol"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="chat_completions">标准对话接口</SelectItem><SelectItem value="responses">新版响应接口</SelectItem></SelectContent></Select><p class="text-xs text-muted-foreground">需与服务商支持的协议一致。</p></div></div>
      <div class="grid content-start gap-2"><Label for="model-base">接入地址</Label><Input id="model-base" v-model="form.base" type="url" maxlength="512" placeholder="https://服务商地址/v1" /><p class="text-xs text-muted-foreground">使用服务商提供的接口地址。</p></div><div class="grid content-start gap-2"><Label for="model-key">访问密钥</Label><Input id="model-key" v-model="form.key" type="password" autocomplete="new-password" maxlength="8192" :placeholder="current?.has_key?'已保存密钥，留空保持不变':'输入访问密钥'" /><p class="text-xs text-muted-foreground">密钥不会回显。更换接入地址时，请重新输入对应密钥。</p></div>
     </section>
     <section aria-labelledby="model-generation-title" class="space-y-4">
      <h2 id="model-generation-title" class="text-sm font-semibold">生成设置</h2>
      <div class="grid gap-4 sm:grid-cols-2"><div class="grid content-start gap-2"><Label for="temperature">温度</Label><Input id="temperature" v-model="capabilities.temperature" type="number" min="0" max="2" step="0.1" placeholder="0 ～ 2" /></div><div class="grid content-start gap-2"><Label for="timeout">请求超时（秒）</Label><Input id="timeout" v-model="capabilities.request_timeout_ms" type="number" min="1" max="600" placeholder="系统默认" /></div></div>
      <div class="rounded-lg bg-muted/40 p-4"><div class="flex items-center justify-between gap-4"><div><Label for="model-thinking">深度思考</Label><p class="mt-1 text-xs leading-5 text-muted-foreground">增加推理深度，响应可能需要更长时间。</p></div><Switch id="model-thinking" v-model="capabilities.thinking_enabled" :disabled="busy" aria-label="启用深度思考" /></div><div v-if="capabilities.thinking_enabled" class="mt-4 border-t pt-4"><div v-if="capabilities.thinking_enabled" class="grid content-start gap-2"><Label for="reasoning-effort">思考深度</Label><Select v-model="capabilities.reasoning_effort" :disabled="busy"><SelectTrigger class="w-full" id="reasoning-effort"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">模型默认</SelectItem><SelectItem value="low">低</SelectItem><SelectItem v-if="!deepseekCapacity" value="medium">中</SelectItem><SelectItem value="high">高</SelectItem><SelectItem value="max">最高</SelectItem></SelectContent></Select></div></div></div>
     </section>
     <section aria-labelledby="model-capacity-title" class="space-y-4 border-t pt-6 lg:col-span-2">
      <div class="flex flex-wrap items-center justify-between gap-2"><h2 id="model-capacity-title" class="text-sm font-semibold">模型容量</h2><Button v-if="deepseekCapacity" type="button" size="sm" variant="ghost" class="h-8 text-xs" @click="fillOfficialCapacity">填入官方容量</Button></div>
      <div class="grid gap-4 sm:grid-cols-3"><div v-for="field in [{key:'context_window_tokens',label:'上下文窗口'},{key:'max_input_tokens',label:'最大输入'},{key:'max_output_tokens',label:'最大输出'}] as const" :key="field.key" class="grid content-start gap-2"><Label :for="field.key">{{field.label}}（词元）</Label><Input :id="field.key" v-model="capabilities[field.key]" type="number" min="1" placeholder="按模型规格填写" /></div></div>
      <p class="text-xs leading-5 text-muted-foreground">每次请求使用最大输出容量。输入、思考和回答共同占用上下文。<a v-if="deepseekCapacity" href="https://docs.volcengine.com/docs/82379/1330310?lang=zh" target="_blank" rel="noopener noreferrer" class="ml-1 text-foreground underline underline-offset-4">查看官方规格</a></p>
     </section>
    </fieldset>
    <p v-if="error" role="alert" class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{{error}}</p>
    <p v-if="notice" role="status" class="flex items-center gap-2 rounded-lg bg-muted p-3 text-sm"><CheckCircle2 class="size-4 shrink-0" />{{notice}}</p>
   </form>
   <footer class="grid shrink-0 gap-3 border-t bg-background px-6 py-4">
    <p class="text-xs leading-5 text-muted-foreground">验证使用已保存配置，最多等待 30 秒，可能产生少量模型用量。</p>
    <div class="flex w-full items-center justify-between gap-3"><Button type="button" variant="outline" :disabled="busy" @click="verify">验证连接</Button><div class="flex gap-2"><Button variant="ghost" :disabled="busy" @click="requestClose">关闭</Button><Button type="button" :disabled="busy" @click="save"><LoaderCircle v-if="busy" class="size-4 animate-spin motion-reduce:animate-none" />{{busy?'处理中…':'保存配置'}}</Button></div></div>
   </footer>
  </DialogContent>
 </Dialog>
 <AlertDialog :open="discardOpen" @update:open="!$event && finishDiscard(false)"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle><AlertDialogDescription>离开后，本次填写但尚未保存的配置将丢失。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>继续编辑</AlertDialogCancel><Button variant="destructive" @click="finishDiscard(true)">放弃修改</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
</template>
