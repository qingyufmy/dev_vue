<script setup lang="ts">
import { KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Checkbox } from '@aurum/ui/checkbox'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Separator } from '@aurum/ui/separator'

import { useLogin } from './use-login'

const { login, password, remember, submitting, redirecting, error, appName, credentialsInvalid, requestInvalid, submit } = useLogin()
</script>

<template>
  <main class="grid min-h-svh place-items-center bg-muted/35 px-4 py-8">
    <div class="grid w-full max-w-5xl overflow-hidden rounded-xl border bg-background lg:grid-cols-[1.05fr_0.95fr]">
      <section class="hidden min-h-[640px] flex-col justify-between border-r bg-muted/45 p-10 lg:flex">
        <div class="flex items-center gap-3">
          <span class="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"><KeyRound aria-hidden="true" /></span>
          <div><p class="font-semibold">量见统一身份中心</p><p class="text-sm text-muted-foreground">一次登录，安全进入各业务应用</p></div>
        </div>
        <div class="max-w-md">
          <p class="text-sm font-medium text-primary">正在进入 {{ appName }}</p>
          <p class="mt-3 text-4xl font-semibold tracking-tight">一个量见账号，连接你的工作与学习。</p>
          <p class="mt-4 leading-7 text-muted-foreground">登录后继续访问主站、交易实验室与获授权的管理服务。</p>
        </div>
        <div class="grid gap-3 text-sm text-muted-foreground">
          <p class="flex items-center gap-2"><ShieldCheck aria-hidden="true" />统一账号，安全登录</p>
          <p class="flex items-center gap-2"><LockKeyhole aria-hidden="true" />仅在个人设备上保持登录</p>
        </div>
      </section>

      <section class="flex min-h-[560px] items-center p-5 sm:p-10">
        <Card class="w-full border-0 shadow-none">
          <CardHeader>
            <CardTitle><h1 class="text-2xl">登录 {{ appName }}</h1></CardTitle>
            <CardDescription>使用量见账号继续。登录完成后将返回刚才的页面。</CardDescription>
          </CardHeader>
          <CardContent>
            <form :aria-busy="submitting" @submit.prevent="submit">
              <FieldGroup>
                <Alert v-if="error" id="login-error" variant="destructive" role="alert">
                  <AlertTitle>登录未完成</AlertTitle>
                  <AlertDescription>{{ error.message }}</AlertDescription>
                </Alert>
                <Field :data-invalid="credentialsInvalid">
                  <FieldLabel for="login">邮箱或手机号</FieldLabel>
                  <Input id="login" v-model="login" autocomplete="username" required maxlength="255" class="min-h-11" :disabled="submitting || requestInvalid" :aria-invalid="credentialsInvalid" :aria-describedby="credentialsInvalid ? 'login-error' : undefined" autofocus />
                </Field>
                <Field :data-invalid="credentialsInvalid">
                  <FieldLabel for="password">密码</FieldLabel>
                  <Input id="password" v-model="password" type="password" autocomplete="current-password" required maxlength="1024" class="min-h-11" :disabled="submitting || requestInvalid" :aria-invalid="credentialsInvalid" :aria-describedby="credentialsInvalid ? 'login-error' : undefined" />
                </Field>
                <Field orientation="horizontal" class="min-h-11 items-center">
                  <Checkbox id="remember" v-model="remember" :disabled="submitting || requestInvalid" />
                  <div class="grid gap-1">
                    <FieldLabel for="remember">保持登录</FieldLabel>
                    <FieldDescription>仅在个人设备上启用，最长 30 天。</FieldDescription>
                  </div>
                </Field>
                <Button type="submit" class="min-h-11 w-full" :disabled="submitting || requestInvalid || !login.trim() || !password">
                  <LoaderCircle v-if="submitting" data-icon="inline-start" aria-hidden="true" class="animate-spin motion-reduce:animate-none" />
                  {{ redirecting ? '登录成功，正在返回' : submitting ? '正在验证' : '安全登录' }}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
          <CardFooter class="flex-col items-stretch gap-4">
            <Separator />
            <p class="text-center text-xs leading-5 text-muted-foreground">遇到账号问题，请返回量见主站寻求帮助。</p>
          </CardFooter>
        </Card>
      </section>
    </div>
  </main>
</template>
