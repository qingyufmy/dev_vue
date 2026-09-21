<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { createApiClient } from '@aurum/api-client'
import { modelSelectionResponseSchema, type ModelSelection } from '@aurum/contracts'
import { Field, FieldDescription, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Checkbox } from '@aurum/ui/checkbox'
import { Button } from '@aurum/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'

const props = withDefaults(defineProps<{ modelValue: Record<string, unknown>; trader: boolean; platform: boolean; idPrefix?: string; showSymbols?: boolean }>(), { idPrefix: 'strategy', showSymbols: true })
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()
const models = ref<ModelSelection['items']>([]), loading = ref(false), error = ref('')
const entries = [{ id: 'market', label: '市价入场' }, { id: 'limit', label: '限价挂单' }, { id: 'stop', label: '突破挂单' }, { id: 'stop_limit', label: '止损限价挂单' }]
const symbols = computed(() => Array.isArray(props.modelValue.symbols) ? props.modelValue.symbols.join('、') : '')
const selectedModel = computed(() => typeof props.modelValue.model_profile_id === 'string' ? props.modelValue.model_profile_id : 'default')
const choices = computed(() => models.value.filter(item => !props.platform || item.scope === 'platform'))
function set(key: string, value: unknown) { emit('update:modelValue', { ...JSON.parse(JSON.stringify(props.modelValue)), [key]: value }) }
function setSymbols(value: string | number) { set('symbols', [...new Set(String(value).toUpperCase().split(/[\s,，、;；]+/).filter(Boolean))]) }
function checked(id: string) { return !Array.isArray(props.modelValue.entry_methods) || props.modelValue.entry_methods.includes(id) }
function toggle(id: string, enabled: boolean | 'indeterminate') {
  const current = entries.filter(item => checked(item.id)).map(item => item.id)
  set('entry_methods', enabled === true ? [...new Set([...current, id])] : current.filter(item => item !== id))
}
async function load() {
  loading.value = true; error.value = ''
  try { models.value = (await createApiClient().request(modelSelectionResponseSchema, '/api/v4/model-selection')).data.items }
  catch { error.value = '模型列表读取失败，已选择的模型不会改变。' }
  finally { loading.value = false }
}
onMounted(load)
</script>

<template>
  <section class="grid gap-5 rounded-xl border bg-muted/15 p-4 sm:p-5">
    <div><h3 class="font-semibold">适用范围与模型</h3><p class="mt-1 text-xs text-muted-foreground">限定策略处理的品种，并选择本策略使用的模型。</p></div>
    <div class="grid gap-5 sm:grid-cols-2">
      <Field v-if="showSymbols">
        <FieldLabel :for="`${idPrefix}-symbols`">支持品种</FieldLabel>
        <Input :id="`${idPrefix}-symbols`" :model-value="symbols" placeholder="XAUUSD、EURUSD" @change="setSymbols(($event.target as HTMLInputElement).value)" />
        <FieldDescription>填写不带券商后缀的标准品种，用逗号分隔；留空表示不限制。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel :for="`${idPrefix}-model`">使用模型</FieldLabel>
        <Select :model-value="selectedModel" :disabled="loading" @update:model-value="set('model_profile_id', $event === 'default' ? null : $event)">
          <SelectTrigger :id="`${idPrefix}-model`"><SelectValue :placeholder="loading ? '正在读取模型…' : '请选择模型'" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">按用途分配的模型</SelectItem>
            <SelectItem v-if="selectedModel !== 'default' && !choices.some(item => item.id === selectedModel)" :value="selectedModel" disabled>原模型暂不可用</SelectItem>
            <SelectItem v-for="item in choices" :key="item.id" :value="item.id" :disabled="!item.available">{{ item.name }}{{ item.available ? '' : ' · 暂不可用' }}</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>{{ platform ? '公共策略可选择公共模型，或沿用使用者的用途分配。' : '指定后优先使用此模型；否则沿用模型配置中的用途分配。' }}</FieldDescription>
        <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }} <Button variant="link" size="sm" @click="load">重试</Button></p>
      </Field>
    </div>
    <Field v-if="trader">
      <FieldLabel>支持的入场方式</FieldLabel>
      <div class="grid gap-3 sm:grid-cols-2">
        <label v-for="entry in entries" :key="entry.id" class="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm">
          <Checkbox :model-value="checked(entry.id)" @update:model-value="toggle(entry.id, $event)" />{{ entry.label }}
        </label>
      </div>
      <FieldDescription>至少选择一种。实际执行还需满足账户、终端及风控条件。</FieldDescription>
    </Field>
  </section>
</template>
