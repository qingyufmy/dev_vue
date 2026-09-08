<script setup lang="ts">
import { useTradeSession } from '~/features/auth'
import BridgePairingPanel from '../components/BridgePairingPanel.vue'
import { useBridgePairing } from '../composables/use-bridge-pairing'

const { session } = useTradeSession()
const { code, error, busy, copied, remaining, generate, copy } = useBridgePairing(session)
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-2">
      <h1 class="text-2xl font-semibold">量见智桥</h1>
      <p class="text-sm leading-6 text-muted-foreground">连接本地 MT4 / MT5，从授权软件开始。</p>
    </header>
    <BridgePairingPanel :code="code" :error="error" :busy="busy" :copied="copied" :remaining="remaining" @generate="generate" @copy="copy" />
  </div>
</template>
