<script setup lang="ts">
import { CheckCircle2, Edit3, FilePlus2, Rocket, ScrollText, Trash2 } from '@lucide/vue'
import type { StrategySummary } from '@aurum/contracts'
import { computed, ref, watch } from 'vue'
import { useTradeSession } from '~/features/auth'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import type { StrategyDetailView } from '../model/strategy-presentation'
import { formatDateTime, strategyKindLabel, strategyStatusLabel, versionLabel } from '../model/strategy-presentation'

const props = withDefaults(defineProps<{
  detail: StrategyDetailView | null
  loading?: boolean
  busy?: boolean
}>(), { loading: false, busy: false })

const emit = defineEmits<{
  'edit-meta': [strategy: StrategySummary]
  'new-version': [detail: StrategyDetailView]
  publish: [versionId: string]
  retire: []
  subscriptions: []
}>()

const { session } = useTradeSession()
const activeVersion = computed(() => props.detail?.versions.find((item) => item.id === props.detail?.strategy.activeVersionId))
const viewingVersionId = ref<string | null>(null)
const viewingVersion = computed(() => props.detail?.versions.find((item) => item.id === viewingVersionId.value))
watch(() => props.detail?.strategy.id, () => { viewingVersionId.value = null })
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <div v-if="loading" class="grid min-h-[34rem] place-items-center" aria-busy="true">
      <div class="grid w-full max-w-xl gap-4 px-6"><div class="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-28 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-48 animate-pulse rounded bg-muted motion-reduce:animate-none" /></div>
    </div>
    <Empty v-else-if="!detail" class="min-h-[34rem]">
      <EmptyHeader><EmptyMedia variant="icon"><ScrollText /></EmptyMedia><EmptyTitle>选择一条策略</EmptyTitle><EmptyDescription>查看策略说明、提示词与版本记录。</EmptyDescription></EmptyHeader>
    </Empty>
    <template v-else>
      <CardHeader class="flex flex-col gap-4 border-b">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{{ strategyKindLabel[detail.strategy.kind] }}</Badge>
          <Badge :variant="detail.strategy.status === 'active' ? 'default' : 'secondary'">{{ strategyStatusLabel[detail.strategy.status] }}</Badge>
          <Badge variant="outline">{{ detail.strategy.scope === 'platform' ? '平台共享' : '我的策略' }}</Badge>
        </div>
        <CardTitle class="text-xl">{{ detail.strategy.name }}</CardTitle>
        <Button v-if="detail.strategy.scope === 'platform' && detail.strategy.status !== 'retired' && session?.permissions.includes('admin')" class="min-h-11 self-start" :disabled="busy" @click="emit('new-version', detail)"><Edit3 />编辑策略</Button>
        <CardDescription class="max-w-3xl text-sm leading-6">{{ detail.strategy.description || '暂无策略说明' }}</CardDescription>
        <div v-if="detail.strategy.scope === 'user' && detail.strategy.status !== 'retired'" class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" :disabled="busy" @click="emit('new-version', detail)"><Edit3 />编辑策略</Button>
          <Button size="sm" :disabled="busy" @click="emit('new-version', detail)"><FilePlus2 />新建版本</Button>
        </div>
      </CardHeader>

      <CardContent class="grid gap-6 pt-6">
        <section class="grid gap-3 rounded-xl border bg-muted/25 p-4" aria-labelledby="active-version-title">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs font-medium text-muted-foreground">当前生效版本</p>
              <h3 id="active-version-title" class="mt-1 text-lg font-semibold">{{ versionLabel(activeVersion) }}</h3>
            </div>
            <Button v-if="activeVersion && detail.strategy.status === 'active'" variant="outline" class="min-h-11" @click="emit('subscriptions')">管理账户订阅</Button>
          </div>
          <p v-if="activeVersion" class="line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{{ activeVersion.promptText }}</p>
          <p v-else class="text-sm text-muted-foreground">{{ detail.strategy.scope === 'platform' ? '此平台策略尚未发布，发布后即可订阅。' : '发布一个版本后，即可在账户中订阅使用。' }}</p>
        </section>

        <section aria-labelledby="version-history-title">
          <div class="flex items-end justify-between gap-3">
            <div><h3 id="version-history-title" class="font-semibold">版本记录</h3><p class="mt-1 text-xs text-muted-foreground">历史版本不可覆盖；修改会生成新版本。</p></div>
            <Badge variant="secondary">{{ detail.versions.length }} 个版本</Badge>
          </div>
          <div class="mt-3 divide-y rounded-xl border">
            <article v-for="version in detail.versions" :key="version.id" class="grid gap-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
              <span class="flex size-10 items-center justify-center rounded-lg bg-muted font-mono text-sm font-semibold">v{{ version.versionNumber }}</span>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2"><strong class="text-sm">{{ version.id === detail.strategy.activeVersionId ? '当前生效' : !activeVersion || version.versionNumber > activeVersion.versionNumber ? '待发布版本' : '历史版本' }}</strong><Badge v-if="version.id === detail.strategy.activeVersionId" variant="default"><CheckCircle2 />已发布</Badge></div>
                <p class="mt-1 truncate text-xs text-muted-foreground">{{ formatDateTime(version.createdAt) }}</p>
              </div>
              <div class="flex flex-wrap gap-2"><Button variant="ghost" size="sm" class="min-h-11" @click="viewingVersionId = version.id">查看版本</Button>
              <Button v-if="(detail.strategy.scope === 'user' || session?.permissions.includes('admin')) && version.id !== detail.strategy.activeVersionId && detail.strategy.status !== 'retired'" variant="outline" size="sm" :disabled="busy" @click="emit('publish', version.id)"><Rocket />发布此版</Button></div>
            </article>
          </div>
        </section>

        <p v-if="detail.strategy.scope === 'platform'" class="text-xs leading-5 text-muted-foreground">平台策略由管理员维护，您可以查看版本并管理自己的账户订阅。</p>
      </CardContent>
      <CardFooter v-if="detail.strategy.scope === 'user' && detail.strategy.status !== 'retired'" class="justify-end border-t">
        <Button variant="destructive" :disabled="busy" @click="emit('retire')"><Trash2 />退役策略</Button>
      </CardFooter>
    </template>
  </Card>
  <Sheet :open="!!viewingVersion" @update:open="!$event && (viewingVersionId = null)">
    <SheetContent class="w-full gap-0 overflow-hidden p-0 data-[side=right]:w-full sm:data-[side=right]:max-w-3xl">
      <SheetHeader class="border-b pr-16 text-left">
        <SheetTitle>{{ detail?.strategy.name }} · {{ versionLabel(viewingVersion) }}</SheetTitle>
        <SheetDescription>查看此版本的完整提示词与配置。</SheetDescription>
      </SheetHeader>
      <div v-if="viewingVersion" class="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <p class="text-xs text-muted-foreground">创建于 {{ formatDateTime(viewingVersion.createdAt) }}</p>
        <section><h3 class="mb-3 font-semibold">提示词</h3><pre class="whitespace-pre-wrap break-words rounded-lg border bg-muted/25 p-4 font-sans text-sm leading-7">{{ viewingVersion.promptText }}</pre></section>
        <details class="rounded-lg border p-4"><summary class="cursor-pointer text-sm font-medium">数据与版本配置</summary>
          <pre class="mt-4 overflow-x-auto whitespace-pre-wrap break-all text-xs leading-6">{{ JSON.stringify(viewingVersion.config, null, 2) }}</pre>
          <p class="mt-4 break-all text-xs leading-6 text-muted-foreground">输入契约：{{ viewingVersion.inputContractVersion }} · 输出契约：{{ viewingVersion.outputContractVersion }}<br>SHA256：{{ viewingVersion.promptSha256 }}</p>
        </details>
      </div>
    </SheetContent>
  </Sheet>
</template>
