<script setup lang="ts">
import { Check, ChevronsUpDown, Search } from '@lucide/vue'
import { computed, nextTick, ref, watch } from 'vue'
import { Button } from '@aurum/ui/button'
import { Input } from '@aurum/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@aurum/ui/popover'
import { ScrollArea } from '@aurum/ui/scroll-area'

const props = defineProps<{ symbols: string[]; modelValue: string; loading?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const open = ref(false)
const query = ref('')
const input = ref<{ $el?: HTMLInputElement } | null>(null)
const resultLimit = 100

const matches = computed(() => {
  const term = query.value.trim().toUpperCase()
  return props.symbols
    .filter(symbol => !term || symbol.toUpperCase().includes(term))
    .sort((left, right) => {
      if (!term) return left.localeCompare(right)
      const leftPrefix = left.toUpperCase().startsWith(term)
      const rightPrefix = right.toUpperCase().startsWith(term)
      return Number(rightPrefix) - Number(leftPrefix) || left.localeCompare(right)
    })
    .slice(0, resultLimit)
})
const totalMatches = computed(() => {
  const term = query.value.trim().toUpperCase()
  return props.symbols.filter(symbol => !term || symbol.toUpperCase().includes(term)).length
})

watch(open, async value => {
  if (!value) return
  query.value = ''
  await nextTick()
  input.value?.$el?.focus()
})

function select(symbol: string) {
  open.value = false
  if (symbol !== props.modelValue) emit('update:modelValue', symbol)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button type="button" variant="outline" class="min-h-11 w-40 justify-between bg-transparent px-3 font-mono font-semibold" :disabled="loading || !symbols.length" aria-label="选择行情品种">
        <span class="truncate">{{ modelValue || (loading ? '同步品种…' : '选择品种') }}</span>
        <ChevronsUpDown class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80 gap-2 p-2" @open-auto-focus.prevent>
      <div class="relative">
        <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input ref="input" v-model="query" class="min-h-11 pl-9" aria-label="搜索行情品种" placeholder="输入 BTC、XAU、EUR…" autocomplete="off" @keydown.enter.prevent="matches[0] && select(matches[0])" />
      </div>
      <ScrollArea class="h-72">
        <div v-if="matches.length" class="grid gap-1 pr-2" role="listbox" aria-label="匹配的行情品种">
          <button v-for="item in matches" :key="item" type="button" role="option" :aria-selected="item === modelValue" class="flex min-h-10 w-full cursor-pointer items-center justify-between rounded-md px-3 text-left font-mono text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none" @click="select(item)">
            <span>{{ item }}</span><Check v-if="item === modelValue" class="size-4 text-primary" aria-hidden="true" />
          </button>
        </div>
        <p v-else class="px-3 py-10 text-center text-sm text-muted-foreground" role="status">没有匹配的品种</p>
      </ScrollArea>
      <p class="border-t px-2 pt-2 text-xs text-muted-foreground" aria-live="polite">
        匹配 {{ totalMatches }} 个品种<template v-if="totalMatches > resultLimit">，当前显示前 {{ resultLimit }} 个，请继续输入缩小范围</template>
      </p>
    </PopoverContent>
  </Popover>
</template>
