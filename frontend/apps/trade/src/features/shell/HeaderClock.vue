<script setup lang="ts">
import { Clock3 } from '@lucide/vue'
import { currentAccount } from '~/features/trading-context'
import { computed, onBeforeUnmount, ref } from 'vue'
import { activeTerminalDisplayTimezone } from '~/lib/laboratory-display-time'
const now = ref(Date.now())
const zone = computed(activeTerminalDisplayTimezone)
const time = computed(() => new Date(now.value + zone.value.offsetMinutes * 60000).toISOString().slice(11, 19))
const timer = setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => clearInterval(timer))
</script>
<template>
  <div class="ml-auto flex h-9 shrink-0 items-center gap-2 rounded-full border border-border/60 bg-muted px-3" :title="`公共行情时间 · ${zone.label} · ${zone.statusLabel}`">
    <Clock3 class="size-5 shrink-0 text-foreground/85" aria-hidden="true" />
    <time class="font-mono text-sm font-semibold tracking-wide text-primary tabular-nums" :aria-label="`${time} ${zone.label}`">{{ time }}</time>
    <span v-if="currentAccount" class="text-[11px] font-semibold text-primary">{{ currentAccount.platform.toUpperCase() }}</span>
  </div>
</template>
