<script setup lang="ts">
import { AlertCircle, CheckCircle2, ShieldAlert } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import type { CompileResultView } from '../model/strategy-presentation'

defineProps<{ result: CompileResultView | null; error?: string }>()
</script>

<template>
  <Alert v-if="error" variant="destructive">
    <AlertCircle aria-hidden="true" />
    <AlertTitle>策略未保存</AlertTitle>
    <AlertDescription>{{ error }}</AlertDescription>
  </Alert>
  <Alert v-else-if="result" :variant="result.valid ? 'default' : 'destructive'">
    <CheckCircle2 v-if="result.valid" aria-hidden="true" />
    <ShieldAlert v-else aria-hidden="true" />
    <AlertTitle>{{ result.valid ? '策略检查通过' : '请检查策略设置' }}</AlertTitle>
    <AlertDescription class="grid gap-3">
      <p>{{ result.valid ? '检查通过，可以保存。' : '请修正以下问题，再点击保存。' }}</p>
      <ul v-if="result.issues.length" class="grid gap-2" aria-label="策略校验问题">
        <li v-for="issue in result.issues" :key="`${issue.code}-${issue.path}`" class="flex items-start gap-2 rounded-md bg-background/70 p-2 text-sm">
          <Badge :variant="issue.level === 'error' ? 'destructive' : 'secondary'">{{ issue.level === 'error' ? '错误' : '提醒' }}</Badge>
          <span>{{ issue.message }}</span>
        </li>
      </ul>
    </AlertDescription>
  </Alert>
</template>
