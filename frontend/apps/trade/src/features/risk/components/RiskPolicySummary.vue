<script setup lang="ts">
import { LockKeyhole, Settings2, ShieldCheck } from '@lucide/vue'
import type { RiskPolicy } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Separator } from '@aurum/ui/separator'
import { formatDecimal } from '../model/risk-presentation'

defineProps<{ policy: RiskPolicy | null; readOnly: boolean }>()
const emit = defineEmits<{ edit: [] }>()
</script>

<template>
  <Card class="h-full shadow-none">
    <CardHeader class="flex-row items-start justify-between gap-4 space-y-0">
      <div><CardTitle class="flex items-center gap-2"><Settings2 class="size-4" aria-hidden="true" />账户风控规则</CardTitle><CardDescription>用户规则只能在平台边界内收紧，不能放宽平台硬限制</CardDescription></div>
      <Button variant="outline" size="sm" class="min-h-11" :disabled="readOnly || !policy" @click="emit('edit')"><Settings2 />编辑规则</Button>
    </CardHeader>
    <CardContent v-if="policy" class="space-y-4">
      <div class="flex flex-wrap gap-2">
        <Badge :variant="policy.tradeSendEnabled ? 'default' : 'secondary'"><ShieldCheck />{{ policy.tradeSendEnabled ? '允许发送交易' : '交易发送关闭' }}</Badge>
        <Badge :variant="policy.accountKillSwitch ? 'destructive' : 'outline'"><LockKeyhole />{{ policy.accountKillSwitch ? '账户已暂停' : '账户未暂停' }}</Badge>
        <Badge v-if="policy.globalKillSwitch" variant="destructive">平台暂停中</Badge>
      </div>
      <Separator />
      <dl class="grid gap-4 sm:grid-cols-2">
        <div><dt class="text-xs text-muted-foreground">单笔最大风险</dt><dd class="mt-1 font-mono font-semibold tabular-nums">{{ formatDecimal(policy.maxRiskPerTradePercent) }}%</dd></div>
        <div><dt class="text-xs text-muted-foreground">最大允许点差</dt><dd class="mt-1 font-mono font-semibold tabular-nums">{{ formatDecimal(policy.maxSpreadPoints, 1) }} 点</dd></div>
        <div><dt class="text-xs text-muted-foreground">最短开仓间隔</dt><dd class="mt-1 font-mono font-semibold tabular-nums">{{ policy.minOpenIntervalSeconds }} 秒</dd></div>
        <div><dt class="text-xs text-muted-foreground">亏损冷静期</dt><dd class="mt-1 font-mono font-semibold tabular-nums">{{ policy.lossCooldownMinutes }} 分钟</dd></div>
      </dl>
      <p class="text-xs leading-5 text-muted-foreground">止损为平台强制要求。规则版本 {{ policy.revision }}，修改后实时用于新的账户级风控评审。</p>
    </CardContent>
    <CardContent v-else><p class="text-sm text-muted-foreground">正在读取账户规则…</p></CardContent>
  </Card>
</template>
