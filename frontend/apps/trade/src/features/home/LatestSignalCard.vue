<script setup lang="ts">
import { BrainCircuit, Maximize2 } from '@lucide/vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
</script>

<template>
  <Card class="flex min-h-[25rem] flex-col shadow-none">
    <CardHeader class="border-b">
      <div class="flex items-center gap-3"><span class="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><BrainCircuit class="size-5" /></span><div><CardTitle class="text-base">最新 AI 分析</CardTitle><CardDescription>按系统账号归档</CardDescription></div></div>
    </CardHeader>
    <CardContent class="flex flex-1 flex-col justify-center px-6 text-center">
      <Badge variant="outline" class="mx-auto">等待分析模块接入</Badge>
      <h2 class="mt-4 text-xl font-semibold">暂无最新分析结果</h2>
      <p class="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">行情与账户链路已经独立接入；AI 方向、动作、置信度和订单参数将在分析师竖切中使用真实结果填充。</p>
    </CardContent>
    <CardFooter class="border-t p-3"><Button class="w-full" variant="outline" disabled><Maximize2 />全屏查看完整推理</Button></CardFooter>
  </Card>
</template>
