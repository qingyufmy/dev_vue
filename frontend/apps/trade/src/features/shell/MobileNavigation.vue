<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { House, SlidersHorizontal, BrainCircuit, Menu, Cable } from '@lucide/vue'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@aurum/ui/sheet'
const props = defineProps<{ groups: { label: string; items: { to: string; label: string; icon: unknown }[] }[] }>()
const route = useRoute(), open = ref(false)
const primary = [
  { to: '/', label: '首页', icon: House },
  { to: '/trader', label: '交易员', icon: SlidersHorizontal }, { to: '/strategist', label: '策略师', icon: BrainCircuit },
]
watch(() => route.path, () => { open.value = false })
</script>
<template>
  <nav aria-label="移动端主导航" class="grid shrink-0 grid-cols-4 border-t bg-background px-1 pb-[env(safe-area-inset-bottom)] md:hidden">
    <RouterLink v-for="item in primary" :key="item.to" :to="item.to" :aria-current="route.path === item.to ? 'page' : undefined" class="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-ring" :class="route.path === item.to ? 'text-primary' : 'text-muted-foreground'">
      <component :is="item.icon" class="size-5" aria-hidden="true" />{{ item.label }}
    </RouterLink>
    <button class="flex min-h-14 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-ring" :class="primary.some(item => route.path === item.to) ? 'text-muted-foreground' : 'text-primary'" aria-label="更多功能" :aria-expanded="open" @click="open = true"><Menu class="size-5" aria-hidden="true" />更多</button>
  </nav>
  <Sheet v-model:open="open">
    <SheetContent side="bottom" class="max-h-[80dvh] overflow-y-auto rounded-t-2xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <SheetHeader><SheetTitle>更多功能</SheetTitle><SheetDescription>选择工作区或查看交易记录</SheetDescription></SheetHeader>
      <div v-for="group in props.groups" :key="group.label" class="pb-3">
        <p class="mb-2 text-xs text-muted-foreground">{{ group.label }}</p>
        <div class="grid grid-cols-2 gap-2">
          <RouterLink v-for="item in group.items" :key="item.to" :to="item.to" class="flex min-h-12 items-center gap-3 rounded-lg bg-muted/50 px-3 text-sm" :class="route.path === item.to ? 'text-primary' : ''" @click="open = false"><component :is="item.icon" class="size-5" aria-hidden="true" />{{ item.label }}</RouterLink>
        </div>
      </div>
      <RouterLink to="/bridge" class="flex min-h-12 items-center gap-3 rounded-lg bg-muted/50 px-3 text-sm" @click="open = false"><Cable class="size-5" />量见智桥</RouterLink>
    </SheetContent>
  </Sheet>
</template>
