<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
import { Alert, AlertDescription } from '@aurum/ui/alert'
import { useTradeSession } from '~/features/auth'
import { useInstallationAuthorization } from '../composables/use-installation-authorization'

const route = useRoute()
const id = computed(() => typeof route.query.request === 'string' ? route.query.request : '')
const { session } = useTradeSession()
const { authorization, busy, error, canDecide, now, load, decide } = useInstallationAuthorization(id, session)
const expired = computed(() => authorization.value && Date.parse(authorization.value.expires_at) <= now.value)
</script>

<template>
  <main class="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 sm:p-8" :aria-busy="busy">
    <Card>
      <CardHeader><CardTitle>授权量见智桥</CardTitle></CardHeader>
      <CardContent class="flex flex-col gap-5">
        <p v-if="busy" role="status">正在确认授权状态…</p>
        <Alert v-if="error" variant="destructive"><AlertDescription>{{ error }}</AlertDescription></Alert>
        <template v-if="authorization">
          <dl class="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm">
            <dt class="text-muted-foreground">当前用户</dt><dd>{{ authorization.current_user.display_name }}（{{ authorization.current_user.id }}）</dd>
            <dt class="text-muted-foreground">设备名称</dt><dd class="break-all">{{ authorization.device_name }}</dd>
            <dt class="text-muted-foreground">设备标识</dt><dd class="break-all">{{ authorization.installation_id }}</dd>
            <dt class="text-muted-foreground">请求有效期</dt><dd>{{ new Date(authorization.expires_at).toLocaleString() }}</dd>
          </dl>
          <p v-if="authorization.status === 'approved'" role="status">已授权，请返回量见智桥添加交易终端。</p>
          <p v-else-if="authorization.status === 'denied'" role="status">已拒绝此次授权。</p>
          <p v-else-if="authorization.status === 'revoked'" role="status">此次授权已撤销，请回到软件重新发起。</p>
          <p v-else-if="expired || authorization.status === 'expired'" role="status">请求已过期，请回到软件重新发起。</p>
          <template v-else>
            <p class="text-sm leading-6 text-muted-foreground">同意后，这台软件可以为当前用户添加交易终端，并在重启后继续连接。请确认这是你刚刚在自己电脑上发起的请求。</p>
            <div class="flex flex-wrap gap-3">
              <Button :disabled="!canDecide" @click="decide('approved')">同意授权</Button>
              <Button variant="outline" :disabled="!canDecide" @click="decide('denied')">拒绝</Button>
            </div>
          </template>
        </template>
        <Button variant="ghost" :disabled="busy" @click="load">刷新状态</Button>
      </CardContent>
    </Card>
  </main>
</template>
