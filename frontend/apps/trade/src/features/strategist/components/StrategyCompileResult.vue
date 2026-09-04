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
    <AlertTitle>校验请求失败</AlertTitle>
    <AlertDescription>{{ error }}</AlertDescription>
  </Alert>
  <Alert v-else-if="result" :variant="result.valid ? 'default' : 'destructive'">
    <CheckCircle2 v-if="result.valid" aria-hidden="true" />
    <ShieldAlert v-else aria-hidden="true" />
    <AlertTitle>{{ result.valid ? '策略合同校验通过' : '策略合同仍有问题' }}</AlertTitle>
    <AlertDescription class="grid gap-3">
      <p>{{ result.valid ? '可以保存为不可变版本。发布后，新订阅会绑定这个版本。' : '修正错误后重新校验，未通过的提示词不会保存或发布。' }}</p>
      <ul v-if="result.issues.length" class="grid gap-2" aria-label="策略校验问题">
        <li v-for="issue in result.issues" :key="`${issue.code}-${issue.path}`" class="flex items-start gap-2 rounded-md bg-background/70 p-2 text-sm">
          <Badge :variant="issue.level === 'error' ? 'destructive' : 'secondary'">{{ issue.level === 'error' ? '错误' : '提醒' }}</Badge>
          <span>{{ issue.message }}</span>
        </li>
      </ul>
      <p v-if="result.valid" class="font-mono text-xs text-muted-foreground">{{ result.inputContractVersion }} → {{ result.outputContractVersion }} · {{ result.promptSha256.slice(0, 16) }}</p>
    </AlertDescription>
  </Alert>
</template>
