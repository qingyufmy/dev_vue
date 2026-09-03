<script setup lang="ts">
import { ArrowRight, Boxes, CircleGauge, DatabaseZap, ShieldCheck } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { RouterLink } from 'vue-router'

const areas = [
  { icon: CircleGauge, title: '运营信号', text: '等待用户、会员、订单和内容指标接入' },
  { icon: DatabaseZap, title: '任务与依赖', text: '等待异步任务和外部依赖健康摘要接入' },
  { icon: ShieldCheck, title: '风险与审计', text: '等待权限、风控和敏感操作摘要接入' },
]
</script>

<template>
  <div class="mx-auto w-full max-w-[1600px] space-y-6 p-4 sm:p-6 lg:p-8">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="text-sm font-medium text-primary">平台运营</p>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">运营概览</h1>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">优先呈现需要处理的事项、平台健康和业务变化；当前阶段不展示伪造统计。</p>
      </div>
      <Button as-child variant="outline">
        <RouterLink to="/site-settings">配置站点与域名<ArrowRight data-icon="inline-end" /></RouterLink>
      </Button>
    </div>

    <Alert>
      <Boxes />
      <AlertTitle>后台独立应用骨架已启用</AlertTitle>
      <AlertDescription>后台不再与主站或交易实验室共享页面代码，后续能力按领域逐项迁入。</AlertDescription>
    </Alert>

    <div class="grid gap-4 md:grid-cols-3">
      <Card v-for="area in areas" :key="area.title" class="shadow-none">
        <CardHeader>
          <span class="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <component :is="area.icon" class="size-5" aria-hidden="true" />
          </span>
          <CardTitle>{{ area.title }}</CardTitle>
          <CardDescription class="leading-6">{{ area.text }}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  </div>
</template>
