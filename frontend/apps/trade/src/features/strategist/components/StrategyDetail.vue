<script setup lang="ts">
import { CheckCircle2, Edit3, FilePlus2, LockKeyhole, Rocket, ScrollText, ShieldCheck, Trash2 } from '@lucide/vue'
import type { StrategySummary } from '@aurum/contracts'
import { computed } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Separator } from '@aurum/ui/separator'
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
}>()

const activeVersion = computed(() => props.detail?.versions.find((item) => item.id === props.detail?.strategy.activeVersionId))
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <div v-if="loading" class="grid min-h-[34rem] place-items-center" aria-busy="true">
      <div class="grid w-full max-w-xl gap-4 px-6"><div class="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-28 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-48 animate-pulse rounded bg-muted motion-reduce:animate-none" /></div>
    </div>
    <Empty v-else-if="!detail" class="min-h-[34rem]">
      <EmptyHeader><EmptyMedia variant="icon"><ScrollText /></EmptyMedia><EmptyTitle>选择一条策略</EmptyTitle><EmptyDescription>查看提示词版本、发布状态与数据契约。</EmptyDescription></EmptyHeader>
    </Empty>
    <template v-else>
      <CardHeader class="gap-4 border-b">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{{ strategyKindLabel[detail.strategy.kind] }}</Badge>
          <Badge :variant="detail.strategy.status === 'active' ? 'default' : 'secondary'">{{ strategyStatusLabel[detail.strategy.status] }}</Badge>
          <Badge variant="outline">{{ detail.strategy.scope === 'platform' ? '平台共享' : '我的策略' }}</Badge>
        </div>
        <CardTitle class="text-xl">{{ detail.strategy.name }}</CardTitle>
        <CardDescription class="max-w-3xl text-sm leading-6">{{ detail.strategy.description || '暂无策略说明' }}</CardDescription>
        <CardAction v-if="detail.strategy.scope === 'user' && detail.strategy.status !== 'retired'" class="flex gap-2">
          <Button variant="outline" size="sm" :disabled="busy" @click="emit('edit-meta', detail.strategy)"><Edit3 />编辑资料</Button>
          <Button size="sm" :disabled="busy" @click="emit('new-version', detail)"><FilePlus2 />新建版本</Button>
        </CardAction>
      </CardHeader>

      <CardContent class="grid gap-6 pt-6">
        <section class="grid gap-3 rounded-xl border bg-muted/25 p-4" aria-labelledby="active-version-title">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs font-medium text-muted-foreground">当前生效版本</p>
              <h3 id="active-version-title" class="mt-1 text-lg font-semibold">{{ versionLabel(activeVersion) }}</h3>
            </div>
            <Badge v-if="activeVersion" variant="outline"><ShieldCheck />输入 {{ activeVersion.inputContractVersion }} · 输出 {{ activeVersion.outputContractVersion }}</Badge>
          </div>
          <p v-if="activeVersion" class="line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{{ activeVersion.promptText }}</p>
          <p v-else class="text-sm text-muted-foreground">尚未发布版本。订阅只能选择已发布策略。</p>
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
                <div class="flex flex-wrap items-center gap-2"><strong class="text-sm">{{ version.id === detail.strategy.activeVersionId ? '当前生效' : '历史版本' }}</strong><Badge v-if="version.id === detail.strategy.activeVersionId" variant="default"><CheckCircle2 />已发布</Badge></div>
                <p class="mt-1 truncate text-xs text-muted-foreground">{{ formatDateTime(version.createdAt) }} · {{ version.promptSha256.slice(0, 12) }}</p>
              </div>
              <Button v-if="detail.strategy.scope === 'user' && version.id !== detail.strategy.activeVersionId && detail.strategy.status !== 'retired'" variant="outline" size="sm" :disabled="busy" @click="emit('publish', version.id)"><Rocket />发布此版</Button>
            </article>
          </div>
        </section>

        <Separator />
        <div class="flex items-start gap-3 text-sm text-muted-foreground">
          <LockKeyhole class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>策略负责描述分析或交易判断逻辑；账户风控、权限、幂等与终端执行仍由服务端确定性规则控制。</p>
        </div>
      </CardContent>
      <CardFooter v-if="detail.strategy.scope === 'user' && detail.strategy.status !== 'retired'" class="justify-end border-t">
        <Button variant="destructive" :disabled="busy" @click="emit('retire')"><Trash2 />退役策略</Button>
      </CardFooter>
    </template>
  </Card>
</template>
