<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref,watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { createApiClient } from '@aurum/api-client'
import { Button } from '@aurum/ui/button'
import { Card,CardContent,CardHeader,CardTitle,CardDescription } from '@aurum/ui/card'
import { Alert,AlertTitle,AlertDescription } from '@aurum/ui/alert'
import { Label } from '@aurum/ui/label'
import { Input } from '@aurum/ui/input'
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@aurum/ui/select'
import { useAdminSession } from '../auth'
import { createSettingEditorController } from './setting-editor-controller'
import { settingChoices } from './setting-catalog'
const {session}=useAdminSession()
const actor=()=>session.value?.user.id??''
const controller=createSettingEditorController(createApiClient(),actor())
const state=ref(controller.snapshot()),selected=ref('smtp/port'),draft=ref(''),notice=ref('')
const choice=computed(()=>settingChoices.find(x=>`${x.namespace}/${x.key}`===selected.value)!)
const pending=computed(()=>!!state.value.write.pending)
const dirty=computed(()=>!!state.value.current&&!state.value.current.protected&&draft.value!==(state.value.current.value??''))
const editable=computed(()=>choice.value.editable&&!!state.value.current&&!state.value.current.protected&&!state.value.loading&&!pending.value)
const validation=computed(()=>{
 if(!editable.value)return ''
 if(choice.value.type==='integer'&&(!/^(0|[1-9][0-9]*)$/.test(draft.value)||/[^0-9]/.test(draft.value)||draft.value.length>20))return '请输入不带空格或小数的整数。'
 if(choice.value.minimum&&(BigInt(draft.value)<BigInt(choice.value.minimum)||BigInt(draft.value)>BigInt(choice.value.maximum!)))return `允许范围：${choice.value.minimum}—${choice.value.maximum}`
 return ''
})
const sync=()=>{state.value=controller.snapshot()}
async function load(){notice.value='';const task=controller.load(actor(),{namespace:choice.value.namespace,key:choice.value.key});sync();await task;sync();draft.value=state.value.current&&!state.value.current.protected?state.value.current.value??'':''}
async function select(value:unknown){if(typeof value!=='string'||pending.value)return;if(dirty.value){notice.value='请先保存或撤销当前修改。';return}selected.value=value;await load()}
async function save(recover=false){notice.value='';try{const task=recover?controller.recover(actor(),session.value?.csrf_token??''):controller.save(actor(),draft.value,session.value?.csrf_token??'');sync();await task;notice.value='保存已确认。'}catch{notice.value=controller.snapshot().write.phase==='uncertain'?'尚未确认保存结果。请保留此页面，使用“确认保存结果”继续。':'未能保存，请重新读取并检查配置内容。'}finally{sync();if(state.value.write.phase==='complete'&&state.value.current&&!state.value.current.protected)draft.value=state.value.current.value??''}}
function discard(){draft.value=state.value.current&&!state.value.current.protected?state.value.current.value??'':'';notice.value=''}
function beforeUnload(e:BeforeUnloadEvent){if(pending.value||dirty.value){e.preventDefault();e.returnValue=''}}
onBeforeRouteLeave(()=>{if(pending.value||dirty.value){notice.value=pending.value?'请先确认保存结果，再离开此页面。':'请先保存或撤销修改，再离开此页面。';return false}})
watch(()=>session.value?.user.id,()=>{controller.suspend();sync();draft.value='';notice.value='会话已变化，请重新进入此页面。'})
onMounted(()=>{window.addEventListener('beforeunload',beforeUnload);void load()})
onBeforeUnmount(()=>{window.removeEventListener('beforeunload',beforeUnload);controller.suspend()})
</script>
<template>
 <main class="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
  <header><p class="text-sm font-medium text-primary">平台管理</p><h1 class="mt-1 text-2xl font-semibold">系统设置</h1><p class="mt-2 text-sm leading-6 text-muted-foreground">查看已保存的配置。每次保存均检查版本并记录变更。</p></header>
  <Card class="shadow-none"><CardHeader><CardTitle>选择配置</CardTitle><CardDescription>需要专用业务校验的配置当前仅供查看。</CardDescription></CardHeader><CardContent class="space-y-2">
   <Label for="setting-choice">配置项</Label><Select :model-value="selected" :disabled="pending||state.loading" @update:model-value="select"><SelectTrigger id="setting-choice" class="min-h-11 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="item in settingChoices" :key="`${item.namespace}/${item.key}`" :value="`${item.namespace}/${item.key}`">{{item.group}} · {{item.label}}</SelectItem></SelectContent></Select>
  </CardContent></Card>
  <Alert v-if="notice" role="status" aria-live="polite"><AlertTitle>{{pending?'等待确认':'操作提示'}}</AlertTitle><AlertDescription>{{notice}}</AlertDescription></Alert>
  <Card class="shadow-none" :aria-busy="state.loading"><CardHeader><CardTitle>{{choice.label}}</CardTitle><CardDescription v-if="state.current">当前版本 {{state.current.revision}}</CardDescription><Button v-if="state.current" variant="outline" class="mt-2 min-h-11 w-fit" :disabled="pending||dirty||state.loading" @click="load">重新读取</Button></CardHeader><CardContent class="space-y-4">
   <p v-if="state.loading" role="status">正在读取配置…</p>
   <div v-else-if="state.error" role="alert" class="space-y-3"><p>{{state.error==='setting_missing'?'此配置尚无已迁移记录，暂时不能编辑。':'读取失败，请检查登录状态后重试。'}}</p><Button variant="outline" class="min-h-11" @click="load">重新读取</Button></div>
   <template v-else-if="state.current">
    <p v-if="state.current.protected" class="text-sm text-muted-foreground">此项为受保护凭据。{{state.current.value_state==='text'?'已配置':'尚未配置'}}，本页不显示或修改凭据。</p>
    <template v-else>
     <p v-if="!choice.editable" class="text-sm text-muted-foreground">此项需由专用配置流程校验，当前仅供查看。</p>
     <p v-if="state.current.value_state==='null'" class="text-sm text-muted-foreground">当前未设置值。</p><p v-else-if="state.current.value_state==='empty'" class="text-sm text-muted-foreground">当前值为空文本。</p>
     <Label for="setting-value">配置值</Label>
     <Select v-if="choice.type==='boolean'||choice.values" v-model="draft" :disabled="!editable"><SelectTrigger id="setting-value" class="min-h-11 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="value in choice.values??['true','false']" :key="value" :value="value">{{value==='true'?'启用':value==='false'?'停用':value}}</SelectItem></SelectContent></Select>
     <Input v-else id="setting-value" v-model="draft" :readonly="!editable" :disabled="pending" class="min-h-11" :aria-invalid="!!validation" aria-describedby="setting-validation" />
     <p id="setting-validation" role="alert" class="text-sm text-destructive">{{validation}}</p>
     <div v-if="choice.editable" class="flex flex-wrap gap-3"><Button class="min-h-11" :disabled="!editable||!dirty||!!validation" @click="save(false)">保存修改</Button><Button variant="outline" class="min-h-11" :disabled="pending||!dirty" @click="discard">撤销修改</Button></div>
    </template>
   </template>
   <Button v-if="state.write.phase==='uncertain'" class="min-h-11" @click="save(true)">确认保存结果</Button><p v-else-if="state.write.phase==='submitting'" role="status">正在确认保存，请勿关闭页面…</p>
  </CardContent></Card>
 </main>
</template>
