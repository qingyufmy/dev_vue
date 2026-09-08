<script setup lang="ts">
import type { EconomicCalendarEvent } from '@aurum/contracts'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
import { formatBeijingTime } from '@aurum/ui/lib/time'
defineProps<{ events: readonly EconomicCalendarEvent[] }>()
const status = { scheduled: '待公布', released: '已公布', revised: '已修订', delayed: '延期', cancelled: '已取消' }
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader><CardTitle>未来七天的重要事件</CardTitle><p class="text-sm text-muted-foreground">高影响事件 · 北京时间</p></CardHeader>
    <CardContent>
      <p v-if="!events.length" class="py-6 text-sm text-muted-foreground">当前没有可展示的重要事件。</p>
      <ul v-else class="divide-y">
        <li v-for="event in events" :key="event.id" class="grid gap-2 py-4 first:pt-0">
          <div class="flex flex-wrap items-start justify-between gap-2"><h3 class="min-w-0 break-words font-medium">{{ event.title }}</h3><span class="text-xs text-muted-foreground">{{ status[event.status] }}</span></div>
          <p class="text-xs text-muted-foreground">{{ event.country }} · {{ event.currency ?? '—' }} · {{ formatBeijingTime(event.scheduledAt) }}<span v-if="event.timePrecision !== 'exact'">（时间待定）</span></p>
          <dl class="grid grid-cols-3 gap-2 text-sm"><div><dt class="text-xs text-muted-foreground">前值</dt><dd class="break-all tabular-nums">{{ event.previous ?? '—' }}</dd></div><div><dt class="text-xs text-muted-foreground">预期</dt><dd class="break-all tabular-nums">{{ event.consensus ?? '—' }}</dd></div><div><dt class="text-xs text-muted-foreground">实际</dt><dd class="break-all tabular-nums">{{ event.actual ?? '待公布' }}</dd></div></dl>
          <p v-if="event.unit" class="text-xs text-muted-foreground">单位：{{ event.unit }}</p>
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
