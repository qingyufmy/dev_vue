<script setup lang="ts">
import { Copy, KeyRound } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'

defineProps<{ code: string; error: string; busy: boolean; copied: boolean; remaining: number }>()
defineEmits<{ generate: []; copy: [] }>()
</script>

<template>
  <Card class="min-w-0">
    <CardHeader>
      <CardTitle>授权一台量见智桥</CardTitle>
      <CardDescription>在已安装的软件中粘贴配对码，将新终端档案关联到当前登录用户。</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-6">
      <ol class="flex flex-col gap-3 text-sm leading-6 text-muted-foreground">
        <li>1. 在此页面生成配对码。</li>
        <li>2. 打开量见智桥，点击“新增档案”，填写终端信息并粘贴配对码。</li>
        <li>3. 在软件中完成配对并保存档案，再查看连接状态。</li>
      </ol>
      <FieldGroup v-if="code">
        <Field>
          <FieldLabel for="bridge-pairing-code">一次性配对码</FieldLabel>
          <Input id="bridge-pairing-code" :model-value="code" readonly autocomplete="off" spellcheck="false" class="h-11 min-w-0" />
          <FieldDescription>剩余 {{ Math.floor(remaining / 60) }} 分 {{ remaining % 60 }} 秒。仅在自己的软件中使用，不要发送给他人。</FieldDescription>
        </Field>
      </FieldGroup>
      <Alert v-if="error" variant="destructive">
        <AlertTitle>需要处理</AlertTitle><AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <p v-if="copied" role="status" class="text-sm">已复制，请切换到量见智桥粘贴。</p>
    </CardContent>
    <CardFooter class="flex flex-col items-stretch gap-3 sm:items-start">
      <Button v-if="!code" size="lg" :disabled="busy" :aria-busy="busy" @click="$emit('generate')">
        <KeyRound data-icon="inline-start" />{{ busy ? '正在生成…' : error ? '重试生成' : '生成配对码' }}
      </Button>
      <Button v-else size="lg" @click="$emit('copy')"><Copy data-icon="inline-start" />{{ copied ? '再次复制' : '复制配对码' }}</Button>
      <p class="text-xs leading-5 text-muted-foreground">配对不等于终端已连接，也不会自动下单。连接结果请以软件实际状态为准。</p>
    </CardFooter>
  </Card>
</template>
