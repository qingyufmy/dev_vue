<script setup lang="ts">
import { ArrowRight, Blocks, ShieldCheck } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'

const next = new URLSearchParams(window.location.search).get('next') || '/'
const startHref = `/auth/start?next=${encodeURIComponent(next.startsWith('/') && !next.startsWith('//') ? next : '/')}`
</script>

<template>
  <main class="grid min-h-svh place-items-center bg-muted/35 px-4 py-8">
    <Card class="w-full max-w-md">
      <CardHeader>
        <span class="mb-4 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Blocks aria-hidden="true" /></span>
        <CardTitle class="text-2xl">登录量见管理后台</CardTitle>
        <CardDescription>仅管理员可建立后台会话，管理请求会持续复核角色与会话强度。</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4">
        <Alert>
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>受保护的管理入口</AlertTitle>
          <AlertDescription>已登录主站或交易实验室也不会共享后台 Cookie。</AlertDescription>
        </Alert>
        <Button as-child class="w-full">
          <a :href="startHref">前往安全登录<ArrowRight data-icon="inline-end" /></a>
        </Button>
      </CardContent>
    </Card>
  </main>
</template>
