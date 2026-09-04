<script setup lang="ts">
import { AlertCircle, Eye, ShieldCheck, UserRoundX } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import ManualReleaseDialog from '../components/ManualReleaseDialog.vue'
import RiskAccountBar from '../components/RiskAccountBar.vue'
import RiskDecisionHistory from '../components/RiskDecisionHistory.vue'
import RiskDecisionSheet from '../components/RiskDecisionSheet.vue'
import RiskMetricsGrid from '../components/RiskMetricsGrid.vue'
import RiskPolicyEditorSheet from '../components/RiskPolicyEditorSheet.vue'
import RiskPolicySummary from '../components/RiskPolicySummary.vue'
import RiskStateCard from '../components/RiskStateCard.vue'
import { useRiskWorkspace } from '../composables/use-risk-workspace'
import { formatDateTime } from '../model/risk-presentation'

const route = useRoute()
const router = useRouter()
const policyOpen = ref(false)
const releaseOpen = ref(false)
const decisionOpen = ref(false)
const selectedDecisionId = computed(() => typeof route.query.decision_id === 'string' ? route.query.decision_id : '')

function selectDecision(id: string) {
  const query = { ...route.query }
  if (id) query.decision_id = id
  else delete query.decision_id
  void router.replace({ path: '/risk', query })
}

const workspace = useRiskWorkspace(selectedDecisionId, selectDecision)
const realtimeLabel = computed(() => ({ live: '实时同步', connecting: '连接中', recovering: '正在恢复', offline: '快照模式', idle: '未连接' })[workspace.realtime.value])

async function savePolicy(value: Parameters<typeof workspace.savePolicy>[0]) {
  if (await workspace.savePolicy(value)) policyOpen.value = false
}

async function release(reason: string) {
  if (await workspace.createManualRelease(reason)) releaseOpen.value = false
}

function inspectDecision(id: string) {
  selectDecision(id)
  decisionOpen.value = true
}

watch(selectedDecisionId, (id) => {
  if (id) void workspace.loadDetail(id)
  else if (!decisionOpen.value) workspace.detail.value = null
})
watch(decisionOpen, (open) => { if (!open) selectDecision('') })
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1680px] gap-4 p-3 sm:p-5 lg:p-6">
    <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="flex items-center gap-2 text-xs font-medium text-primary"><ShieldCheck class="size-4" aria-hidden="true" />AI 交易团队</div>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight">AI 风控师</h1>
        <p class="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">查看当前账户的实时风险用量，管理用户可编辑的风控边界，并追溯每一次交易动作的服务端风控结论。</p>
      </div>
      <Badge variant="outline"><span class="size-1.5 rounded-full bg-current" aria-hidden="true" />{{ realtimeLabel }}</Badge>
    </header>

    <Alert v-if="workspace.error.value" variant="destructive"><AlertCircle /><AlertTitle>风控工作区读取失败</AlertTitle><AlertDescription>{{ workspace.error.value }}</AlertDescription></Alert>
    <Alert v-else-if="workspace.summaryError.value"><AlertCircle /><AlertTitle>风险快照暂不可用</AlertTitle><AlertDescription>{{ workspace.summaryError.value }}。账户规则仍可查看和编辑，交易动作会继续按服务端缺失数据策略安全拒绝。</AlertDescription></Alert>
    <Alert v-if="workspace.isObserver.value"><Eye /><AlertTitle>观摩模式不开放账户风控</AlertTitle><AlertDescription>风控规则和解除操作只属于交易账户所有者。选择下方本人账户后会退出观摩并进入该账户的风控工作区。</AlertDescription></Alert>

    <RiskAccountBar
      :accounts="workspace.accounts.value"
      :account-id="workspace.activeAccountId.value"
      :account="workspace.account.value"
      :loading="workspace.loading.value || workspace.refreshing.value"
      :switching="workspace.switching.value"
      :observer="workspace.isObserver.value"
      :realtime="workspace.realtime.value"
      @account-change="workspace.selectAccount"
      @refresh="workspace.refresh"
    />

    <Empty v-if="!workspace.loading.value && !workspace.activeAccountId.value" class="min-h-[28rem]">
      <EmptyHeader><EmptyMedia variant="icon"><UserRoundX /></EmptyMedia><EmptyTitle>{{ workspace.isObserver.value ? '请选择本人交易账户' : '还没有可管理的交易账户' }}</EmptyTitle><EmptyDescription>{{ workspace.isObserver.value ? '使用上方账户选择器切换回本人账户后，即可查看和管理该账户的风控。' : '连接量见智桥并绑定交易账户后，账户风控状态会显示在这里。' }}</EmptyDescription></EmptyHeader>
    </Empty>

    <template v-else-if="workspace.activeAccountId.value">
      <RiskStateCard
        :policy="workspace.policy.value"
        :summary="workspace.summary.value"
        :manual-release="workspace.manualRelease.value"
        :read-only="workspace.readOnly.value"
        :releasing="workspace.releasing.value"
        @release="releaseOpen = true"
      />

      <RiskMetricsGrid :policy="workspace.policy.value" :summary="workspace.summary.value" />

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,.85fr)]">
        <RiskPolicySummary :policy="workspace.policy.value" :read-only="workspace.readOnly.value" @edit="policyOpen = true" />
        <section class="grid content-start gap-3 rounded-xl border bg-card p-5" aria-labelledby="risk-context-title">
          <div><h2 id="risk-context-title" class="font-semibold">评审上下文</h2><p class="mt-1 text-xs text-muted-foreground">用于判断当前摘要是否可信和可执行</p></div>
          <dl class="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <div class="rounded-lg bg-muted/40 p-3"><dt class="text-xs text-muted-foreground">业务日期</dt><dd class="mt-1 font-mono font-medium">{{ workspace.summary.value?.businessDate ?? '--' }}</dd></div>
            <div class="rounded-lg bg-muted/40 p-3"><dt class="text-xs text-muted-foreground">连续亏损</dt><dd class="mt-1 font-mono font-medium">{{ workspace.summary.value?.consecutiveLosses ?? '--' }} 次</dd></div>
            <div class="rounded-lg bg-muted/40 p-3"><dt class="text-xs text-muted-foreground">终端时区</dt><dd class="mt-1 font-mono font-medium">{{ workspace.summary.value?.terminalTimezoneOffsetMinutes === null || workspace.summary.value?.terminalTimezoneOffsetMinutes === undefined ? '--' : `UTC${workspace.summary.value.terminalTimezoneOffsetMinutes >= 0 ? '+' : ''}${workspace.summary.value.terminalTimezoneOffsetMinutes / 60}` }}</dd></div>
            <div class="rounded-lg bg-muted/40 p-3"><dt class="text-xs text-muted-foreground">冷静期截止</dt><dd class="mt-1 font-mono text-xs font-medium">{{ formatDateTime(workspace.summary.value?.cooldownUntil, workspace.summary.value?.terminalTimezoneOffsetMinutes) }}</dd></div>
          </dl>
        </section>
      </div>

      <RiskDecisionHistory :items="workspace.decisions.value" :loading="workspace.loading.value" :error="workspace.decisionsError.value" :timezone-offset-minutes="workspace.summary.value?.terminalTimezoneOffsetMinutes" @inspect="inspectDecision" />
    </template>

    <RiskPolicyEditorSheet v-model:open="policyOpen" :policy="workspace.policy.value" :submitting="workspace.savingPolicy.value" :error="workspace.policyError.value" @submit="savePolicy" />
    <ManualReleaseDialog v-model:open="releaseOpen" :availability="workspace.manualRelease.value?.availability ?? null" :submitting="workspace.releasing.value" :error="workspace.releaseError.value" @submit="release" />
    <RiskDecisionSheet v-model:open="decisionOpen" :detail="workspace.detail.value" :loading="workspace.detailLoading.value" :error="workspace.detailError.value" :timezone-offset-minutes="workspace.summary.value?.terminalTimezoneOffsetMinutes" />
  </div>
</template>
