<script setup lang="ts">
import { useTradeSession } from '~/features/auth'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
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
    <Card>
      <CardHeader><CardTitle>在软件中连接账号</CardTitle></CardHeader>
      <CardContent class="space-y-3 text-sm leading-6">
        <p>打开新版量见智桥，点击“连接账号”，在自动打开的网页中确认授权，再回到软件添加 MT4 / MT5 终端。</p>
        <p class="text-muted-foreground">软件授权后可继续添加终端，无需逐次复制配对码；可用连接数量以账号额度为准。</p>
      </CardContent>
    </Card>
    <details class="rounded-lg border p-4">
      <summary class="cursor-pointer text-sm font-medium">无法打开授权网页？使用配对码</summary>
      <div class="mt-4"><BridgePairingPanel :code="code" :error="error" :busy="busy" :copied="copied" :remaining="remaining" @generate="generate" @copy="copy" /></div>
    </details>
  </div>
</template>
