<script setup lang="ts">
import { computed, ref } from 'vue'
import { KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from '@lucide/vue'
import { createApiClient } from '@aurum/api-client'
import { authLoginRequestSchema } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Checkbox } from '@aurum/ui/checkbox'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Separator } from '@aurum/ui/separator'

const client = createApiClient()
const login = ref('')
const password = ref('')
const remember = ref(false)
const submitting = ref(false)
const error = ref('')

const authorization = computed(() => {
  const query = Object.fromEntries(new URLSearchParams(window.location.search).entries())
  return {
    client_id: query.client_id,
    redirect_uri: query.redirect_uri,
    response_type: query.response_type,
    scope: query.scope,
    state: query.state,
    nonce: query.nonce,
    code_challenge: query.code_challenge,
    code_challenge_method: query.code_challenge_method,
  }
})

const appName = computed(() => ({
  'www-web': '量见主站',
  'trade-web': 'AI 交易实验室',
  'admin-web': '量见管理后台',
}[String(authorization.value.client_id)] ?? '量见'))

async function submit() {
  error.value = ''
  const parsed = authLoginRequestSchema.safeParse({
    ...authorization.value,
    login: login.value,
    password: password.value,
    remember: remember.value,
  })
  if (!parsed.success) {
    error.value = '登录请求已失效，请返回原应用重新发起登录。'
    return
  }
  submitting.value = true
  try {
    const response = await client.login(parsed.data)
    window.location.assign(response.data.redirect_to)
  } catch {
    error.value = '账号或密码错误，请检查后重试。'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="grid min-h-svh place-items-center bg-muted/35 px-4 py-8">
    <div class="grid w-full max-w-5xl overflow-hidden rounded-xl border bg-background shadow-sm lg:grid-cols-[1.05fr_0.95fr]">
      <section class="hidden min-h-[640px] flex-col justify-between border-r bg-muted/45 p-10 lg:flex">
        <div class="flex items-center gap-3">
          <span class="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"><KeyRound aria-hidden="true" /></span>
          <div><p class="font-semibold">量见统一身份中心</p><p class="text-sm text-muted-foreground">一次登录，安全进入各业务应用</p></div>
        </div>
        <div class="max-w-md">
          <p class="text-sm font-medium text-primary">正在进入 {{ appName }}</p>
          <h1 class="mt-3 text-4xl font-semibold tracking-tight">账号凭据只在这里输入。</h1>
          <p class="mt-4 leading-7 text-muted-foreground">主站、交易实验室和管理后台分别建立独立会话。任何应用都不能读取其它子域的登录凭据。</p>
        </div>
        <div class="grid gap-3 text-sm text-muted-foreground">
          <p class="flex items-center gap-2"><ShieldCheck aria-hidden="true" />Host-only 安全会话</p>
          <p class="flex items-center gap-2"><LockKeyhole aria-hidden="true" />浏览器不保存访问令牌</p>
        </div>
      </section>

      <section class="flex min-h-[560px] items-center p-5 sm:p-10">
        <Card class="w-full border-0 shadow-none">
          <CardHeader>
            <CardTitle class="text-2xl">登录 {{ appName }}</CardTitle>
            <CardDescription>使用量见账号继续。登录完成后将返回刚才的页面。</CardDescription>
          </CardHeader>
          <CardContent>
            <form @submit.prevent="submit">
              <FieldGroup>
                <Alert v-if="error" variant="destructive">
                  <AlertTitle>登录未完成</AlertTitle>
                  <AlertDescription>{{ error }}</AlertDescription>
                </Alert>
                <Field :data-invalid="Boolean(error)">
                  <FieldLabel for="login">邮箱或手机号</FieldLabel>
                  <Input id="login" v-model="login" autocomplete="username" inputmode="email" :aria-invalid="Boolean(error)" autofocus />
                </Field>
                <Field :data-invalid="Boolean(error)">
                  <FieldLabel for="password">密码</FieldLabel>
                  <Input id="password" v-model="password" type="password" autocomplete="current-password" :aria-invalid="Boolean(error)" />
                  <FieldError v-if="error">{{ error }}</FieldError>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox id="remember" v-model="remember" />
                  <div class="grid gap-1">
                    <FieldLabel for="remember">保持登录</FieldLabel>
                    <FieldDescription>仅在个人设备上启用，最长 30 天。</FieldDescription>
                  </div>
                </Field>
                <Button type="submit" class="w-full" :disabled="submitting || !login || !password">
                  <LoaderCircle v-if="submitting" data-icon="inline-start" class="animate-spin" />
                  {{ submitting ? '正在验证' : '安全登录' }}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
          <CardFooter class="flex-col items-stretch gap-4">
            <Separator />
            <p class="text-center text-xs leading-5 text-muted-foreground">遇到账号问题，请通过主站帮助入口处理。身份中心不承载会员、交易或后台业务页面。</p>
          </CardFooter>
        </Card>
      </section>
    </div>
  </main>
</template>
