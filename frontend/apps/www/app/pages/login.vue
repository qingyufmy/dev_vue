<script setup lang="ts">
import { ArrowRight, LogIn, ShieldCheck } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Separator } from '@aurum/ui/separator'

useSeoMeta({ title: '登录｜量见', robots: 'noindex, nofollow' })
const route = useRoute()
const next = computed(() => {
  const value = String(route.query.next ?? '/')
  return value.startsWith('/') && !value.startsWith('//') ? value : '/'
})
const startHref = computed(() => `/auth/start?next=${encodeURIComponent(next.value)}`)
</script>

<template>
  <section class="mx-auto flex min-h-[calc(100svh-9rem)] max-w-lg items-center px-4 py-16">
    <Card class="w-full">
      <CardHeader>
        <span class="mb-4 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground"><LogIn aria-hidden="true" /></span>
        <CardTitle class="text-2xl">登录量见</CardTitle>
        <CardDescription>继续学习课程、管理会员与订单。账号密码统一由量见身份中心验证。</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4">
        <Alert>
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>安全单点登录</AlertTitle>
          <AlertDescription>登录后进入其他量见应用，无需再次输入账号密码。</AlertDescription>
        </Alert>
        <Button as-child class="w-full">
          <a :href="startHref">前往安全登录<ArrowRight data-icon="inline-end" /></a>
        </Button>
      </CardContent>
      <CardFooter class="flex-col items-stretch gap-4">
        <Separator />
        <p class="text-center text-xs text-muted-foreground">主站只持有自己的 Host-only 会话，不读取交易或后台会话。</p>
      </CardFooter>
    </Card>
  </section>
</template>
