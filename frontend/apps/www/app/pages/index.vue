<script setup lang="ts">
import { ArrowRight, BookOpenText, ChartCandlestick, ShieldCheck } from '@lucide/vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'

useSeoMeta({
  title: '量见｜AI 交易课程与智能交易服务',
  description: '量见提供面向普通外汇交易者的课程、AI 行情分析、风险管理与交易复盘服务。',
  ogTitle: '量见｜让复杂交易判断更清晰',
  ogDescription: '课程、AI 分析、风控与复盘，组织成普通交易者也能看懂的完整工作流。',
})

const capabilities = [
  { icon: BookOpenText, title: '系统化课程', text: '从交易基础到策略方法，用清楚的学习路径降低理解门槛。' },
  { icon: ChartCandlestick, title: 'AI 交易实验室', text: '连接本地 MT4 / MT5，查看分析、风控、执行与复盘全过程。' },
  { icon: ShieldCheck, title: '可解释的安全边界', text: '区分 AI 建议、服务端风控与终端结果，不把建议描述成已成交。' },
]
</script>

<template>
  <section class="border-b">
    <div class="mx-auto grid max-w-7xl items-center gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[1.05fr_.95fr] lg:px-8 lg:py-36">
      <div class="max-w-2xl">
        <Badge variant="secondary" class="mb-6">AI 交易教育与服务平台</Badge>
        <h1 class="text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
          让复杂的交易判断，变得清晰、可核验
        </h1>
        <p class="mt-6 max-w-xl text-lg leading-8 text-muted-foreground">
          量见把课程、行情分析、风险管理与交易复盘组织成一条完整路径，帮助普通交易者知道系统看到了什么、建议什么，以及最终发生了什么。
        </p>
        <div class="mt-9 flex flex-col gap-3 sm:flex-row">
          <Button as-child size="lg">
            <NuxtLink to="/login">
              进入 AI 交易实验室
              <ArrowRight data-icon="inline-end" />
            </NuxtLink>
          </Button>
          <Button as-child size="lg" variant="outline">
            <NuxtLink to="/#courses">浏览课程</NuxtLink>
          </Button>
        </div>
      </div>

      <Card class="border-primary/20 bg-card shadow-lg">
        <CardHeader>
          <CardDescription>一条可信的交易协作链</CardDescription>
          <CardTitle class="text-2xl">先理解，再决定，最后核验</CardTitle>
        </CardHeader>
        <CardContent class="space-y-0">
          <div v-for="(step, index) in ['AI 解释市场与交易机会', '服务端执行账户风控', 'Bridge 回传真实终端结果']" :key="step" class="flex gap-4 border-t py-5 first:border-t-0 first:pt-0 last:pb-0">
            <span class="aurum-number flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm text-primary">0{{ index + 1 }}</span>
            <p class="pt-1 text-sm font-medium sm:text-base">{{ step }}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  </section>

  <section id="solutions" class="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
    <div class="max-w-2xl">
      <p class="text-sm font-medium text-primary">核心服务</p>
      <h2 class="mt-3 text-3xl font-semibold tracking-tight">从学习到实践，重点始终清楚</h2>
      <p class="mt-4 text-muted-foreground">当前阶段先建立全新的产品骨架；课程与业务内容将在后续阶段按迁移矩阵逐项接入。</p>
    </div>
    <div class="mt-10 grid gap-5 md:grid-cols-3">
      <Card v-for="item in capabilities" :key="item.title" class="shadow-none">
        <CardHeader>
          <span class="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <component :is="item.icon" class="size-5" aria-hidden="true" />
          </span>
          <CardTitle>{{ item.title }}</CardTitle>
          <CardDescription class="leading-6">{{ item.text }}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  </section>
</template>
