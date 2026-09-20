<script setup lang="ts">
import { createAnalysisStatusRealtime } from '~/features/analyst'
import { BrainCircuit, ChevronDown } from '@lucide/vue'
import AnalysisSettingsPanel from './AnalysisSettingsPanel.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useTradeSession } from '~/features/auth'
import { currentAccount, tradingContext, tradingAccounts } from '~/features/trading-context'
import TraderRuntimeSwitch from './TraderRuntimeSwitch.vue'
import type { StrategySubscription } from '@aurum/contracts'
import { Button } from '@aurum/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@aurum/ui/sheet'
import { strategistApi } from '../api/strategist-api'
const { session } = useTradeSession()
const items = ref<StrategySubscription[]>([]), error = ref(''), loading = ref(false), open = ref(false)
const editorFocus = ref<'analysis' | 'trader'>('analysis')
const editorOpen = ref(false), editingId = ref<string | null>(null), editingAccount = ref('')
const onlineAccounts = computed(() => tradingAccounts.value.filter(account => account.bridgeState === 'online'))
const accountSubscriptions = ref<Record<string, StrategySubscription[]>>({})
const strategyNames = ref<Record<string, string>>({})
const listLoading = ref(false), listError = ref('')
let listGeneration = 0
const now = ref(Date.now())
const scope = computed(() => `${session.value?.user.id}:${session.value?.authenticated_at}:${tradingContext.value?.mode}:${currentAccount.value?.id}`)
const readonly = computed(() => tradingContext.value?.mode === 'observer' || !currentAccount.value)
let timer: ReturnType<typeof setTimeout> | undefined
const clock = setInterval(() => { now.value = Date.now() }, 1000)
let generation = 0
const runningJobs = ref<Record<string, number>>({})
let analysisConnection: ReturnType<typeof createAnalysisStatusRealtime> | undefined
const analyzing = computed(() => enabledAnalysis.value.length > 0 && Object.values(runningJobs.value).some(at => now.value - at < 15 * 60000))
async function load() {
  const captured = scope.value, version = ++generation, account = currentAccount.value?.id
  if (!account || !session.value || readonly.value) return
  loading.value = true
  try {
    const result = await strategistApi.listSubscriptions(account)
    if (captured !== scope.value || version !== generation) return
    items.value = result.data.items.filter(i => i.tradingAccountId === account && i.status !== 'ended'); error.value = ''
  } catch { if (captured === scope.value && version === generation) error.value = '运行设置读取失败，请重试' }
  finally { if (version === generation) loading.value = false }
}
watch(scope, () => {
  generation++; clearTimeout(timer); items.value = []; error.value = ''; loading.value = false; open.value = false; editorOpen.value = false
  const captured = scope.value
  analysisConnection?.stop(); runningJobs.value = {}
  if (session.value && !readonly.value) analysisConnection = createAnalysisStatusRealtime({
    session: session.value,
    onState: state => { if (state !== 'live') runningJobs.value = {} },
    resync: load,
    onEvent: event => {
      if (captured !== scope.value || event.type !== 'analysis.job.changed') return
      const data = event.data as Record<string, unknown>
      if (!enabledAnalysis.value.some(item => item.analysisStrategyId === String(data.strategy_id) && item.standardSymbol === data.symbol)) return
      if (data.status === 'running') runningJobs.value[event.resource.id] = Date.now()
      else delete runningJobs.value[event.resource.id]
      if (data.status !== 'running') void load()
    },
  })
  async function refresh() { await load(); if (captured === scope.value) timer = setTimeout(refresh, 30000) }
  void refresh()
}, { immediate: true })
onBeforeUnmount(() => { generation++; clearTimeout(timer); clearInterval(clock); analysisConnection?.stop() })
const enabledAnalysis = computed(() => items.value.filter(i => i.status === 'active' && i.analysisEnabled))
const countdown = computed(() => {
  const dates = enabledAnalysis.value.flatMap(i => i.schedule.nextDueAt ? [Date.parse(i.schedule.nextDueAt)] : [])
  if (!dates.length) return ''
  const seconds = Math.ceil((Math.min(...dates) - now.value) / 1000)
  return seconds <= 0 ? '等待调度' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
})
function edit(id: string | null, accountId = currentAccount.value?.id ?? '', focus: 'analysis' | 'trader' = 'analysis') { editorFocus.value = focus; editingAccount.value = accountId; editingId.value = id; open.value = false; editorOpen.value = true }
async function show() {
  const version = ++listGeneration, captured = scope.value
  const accounts = onlineAccounts.value
  if (!accounts.length) { edit(items.value[0]?.id ?? null); return }
  listLoading.value = true; listError.value = ''; accountSubscriptions.value = {}
  if (accounts.length > 1) open.value = true
  try {
    const [catalog, results] = await Promise.all([strategistApi.listStrategies(), Promise.all(accounts.map(async account => ({ account, items: (await strategistApi.listSubscriptions(account.id)).data.items.filter(item => item.tradingAccountId === account.id && item.status !== 'ended') })))])
    if (version !== listGeneration || captured !== scope.value) return
    strategyNames.value = Object.fromEntries(catalog.data.items.map(item => [item.id, item.name]))
    accountSubscriptions.value = Object.fromEntries(results.map(result => [result.account.id, result.items]))
    if (accounts.length === 1) {
      const result = results[0]!
      const chosen = result.items.find(item => item.status === 'active' && item.analysisEnabled) ?? result.items[0]
      edit(chosen?.id ?? null, result.account.id)
    }
  } catch { if (version === listGeneration) { listError.value = '订阅读取失败，请重试。'; open.value = true } }
  finally { if (version === listGeneration) listLoading.value = false }
}
function label(enabled: number) { return !currentAccount.value ? '待选择账户' : readonly.value ? '只读' : error.value ? '待确认' : loading.value && !items.value.length ? '加载中' : !items.value.length ? '未配置' : enabled === items.value.length ? '已开启' : enabled ? '部分开启' : '已关闭' }

</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="outline" size="sm" class="relative isolate h-11 overflow-hidden gap-2 rounded-lg border-border/70 bg-card/60 px-3 font-normal shadow-none hover:bg-muted" :title="currentAccount ? `当前账户：${currentAccount.platform.toUpperCase()} · ${currentAccount.login}` : '请先选择交易账户'" :disabled="readonly || listLoading" @click="show()">
      <span v-if="analyzing" aria-hidden="true" class="analysis-sweep absolute inset-y-0 left-0 -z-10 w-1/2 bg-primary/15" />
      <BrainCircuit class="size-4 text-primary" aria-hidden="true" />
      <span>自动分析</span>
      <span class="text-xs" :class="enabledAnalysis.length ? 'text-primary' : 'text-muted-foreground'">{{ analyzing ? '分析中' : !error && enabledAnalysis.length && countdown ? countdown : label(enabledAnalysis.length) }}</span>
      <ChevronDown class="size-3.5 text-muted-foreground" aria-hidden="true" />
    </Button>
    <TraderRuntimeSwitch :items="items" :loading="loading || !!error" :readonly="readonly" @configure="edit(items.find(item => item.status === 'active')?.id ?? items[0]?.id ?? null, currentAccount?.id, 'trader')" @saved="load" />
  </div>
  <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}<Button variant="link" size="sm" @click="load">刷新</Button></p>
  <AnalysisSettingsPanel v-if="editorOpen && editingAccount" :key="editingAccount" v-model:open="editorOpen" :account-id="editingAccount" :subscription-id="editingId" :focus="editorFocus" @saved="load" />
  <Sheet v-model:open="open">
    <SheetContent class="overflow-y-auto p-5 sm:max-w-xl">
      <SheetHeader><SheetTitle>自动分析订阅</SheetTitle><SheetDescription>查看在线交易账户的订阅，选择需要编辑的一项。</SheetDescription></SheetHeader>
      <p v-if="listLoading" role="status" class="py-6 text-sm text-muted-foreground">正在读取账户订阅…</p>
      <p v-if="listError" role="alert" class="text-sm text-destructive">{{ listError }}</p>
      <section v-for="account in onlineAccounts" :key="account.id" class="rounded-xl border p-4">
        <h3 class="text-sm font-semibold">{{ account.platform.toUpperCase() }} · {{ account.login }}</h3>
        <div v-for="item in accountSubscriptions[account.id] ?? []" :key="item.id" class="mt-3 flex items-center justify-between gap-3 border-t pt-3">
          <div><p class="text-sm font-medium">{{ item.standardSymbol }} · {{ strategyNames[item.analysisStrategyId] ?? '历史策略' }}</p><p class="mt-1 text-xs text-muted-foreground">{{ item.status === 'active' && item.analysisEnabled ? '接收分析已开启' : '接收分析已关闭' }} · {{ item.traderEnabled ? 'AI 交易员已启用' : '仅接收分析' }}</p></div>
          <Button variant="outline" @click="edit(item.id, account.id)">编辑订阅</Button>
        </div>
        <Button v-if="!listLoading && !listError && !accountSubscriptions[account.id]?.length" class="mt-3" variant="outline" @click="edit(null, account.id)">配置订阅</Button>
      </section>
      <Button v-if="listError" variant="outline" @click="show">重新读取</Button>
    </SheetContent>
  </Sheet>

</template>

<style scoped>
.analysis-sweep { animation: analysis-sweep 1.8s ease-in-out infinite; }
@keyframes analysis-sweep { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
@media (prefers-reduced-motion: reduce) { .analysis-sweep { animation: none; width: 100%; } }
</style>
