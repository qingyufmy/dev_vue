<script setup lang="ts">
import { ArrowRight, Bot, Cable, ShieldCheck } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Separator } from '@aurum/ui/separator'

const next = new URLSearchParams(window.location.search).get('next') || '/'
const startHref = `/auth/start?next=${encodeURIComponent(next.startsWith('/') && !next.startsWith('//') ? next : '/')}`
</script>

<template>
  <main data-surface="trade" class="grid min-h-svh place-items-center bg-background px-4 py-8 text-foreground">
    <Card class="w-full max-w-md">
      <CardHeader>
        <span class="mb-4 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Bot aria-hidden="true" /></span>
        <CardTitle class="text-2xl">进入 AI 交易实验室</CardTitle>
        <CardDescription>登录后连接本地 MT4/MT5，查看行情、AI 信号和账户交易状态。</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4">
        <Alert>
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>独立安全会话</AlertTitle>
          <AlertDescription>账号密码只在量见身份中心输入，本应用不会保存登录令牌。</AlertDescription>
        </Alert>
        <Button as-child class="w-full">
          <a :href="startHref">前往安全登录<ArrowRight data-icon="inline-end" /></a>
        </Button>
      </CardContent>
      <CardFooter class="flex-col items-stretch gap-4">
        <Separator />
        <p class="flex items-center justify-center gap-2 text-xs text-muted-foreground"><Cable aria-hidden="true" />Bridge 设备授权与网站登录保持独立</p>
      </CardFooter>
    </Card>
  </main>
</template>
