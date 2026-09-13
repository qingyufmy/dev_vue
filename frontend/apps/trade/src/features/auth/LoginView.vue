<script setup lang="ts">
import { onMounted } from 'vue'
import { ArrowRight, LoaderCircle, ShieldCheck } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { useLoginEntry } from './use-login-entry'

const { issue, checking, message, signedOut, problem, start, checkSession, continueLogin } = useLoginEntry()
onMounted(() => { void start() })
</script>

<template>
  <main class="grid min-h-svh place-items-center bg-background px-4 py-8 text-foreground">
    <Card class="w-full max-w-md shadow-none">
      <CardHeader>
        <span class="mb-3 flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground"><ShieldCheck aria-hidden="true" /></span>
        <CardTitle><h1 class="text-2xl font-semibold">{{ signedOut ? '已退出 AI 交易实验室' : '进入 AI 交易实验室' }}</h1></CardTitle>
        <CardDescription>查看账户、行情和 AI 分析，清楚掌握每一步交易状态。</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-5" :aria-busy="checking">
        <p v-if="checking" role="status" class="flex items-center gap-2 text-sm"><LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在确认登录状态…</p>
        <Alert v-else-if="problem || message" :variant="problem ? 'destructive' : 'default'">
          <AlertTitle>{{ issue === 'forbidden' ? '无法进入应用' : '登录未完成' }}</AlertTitle>
          <AlertDescription>{{ problem || message }}</AlertDescription>
        </Alert>
        <p v-else class="text-sm leading-6 text-muted-foreground">{{ signedOut ? '其它量见应用的登录状态仍然保留。再次进入时可能无需输入密码。' : '已在其它量见应用登录？我们会为你自动衔接，无需再次输入密码。' }}</p>
        <Button v-if="!checking && (issue === 'unavailable' || issue === 'forbidden')" class="min-h-11 w-full" @click="checkSession">{{ issue === 'forbidden' ? '重新检查权限' : '重新检查连接' }}</Button>
        <Button v-else-if="!checking" class="min-h-11 w-full" @click="continueLogin">{{ signedOut ? '重新进入' : '继续登录' }}<ArrowRight aria-hidden="true" /></Button>
      </CardContent>
    </Card>
  </main>
</template>
