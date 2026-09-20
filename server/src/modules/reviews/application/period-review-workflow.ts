import { freezeReviewPeriod, type ReviewPeriod } from '../domain/review-period.js'
import { reviewPeriodCalendar, type ReviewPeriodKind } from '../domain/review-period-calendar.js'

export interface PeriodReviewScope {
  userId: number; accountId: string; ownershipIntervalId: string; kind: ReviewPeriodKind; key: string
}
export interface PeriodReviewPlan {
  period: ReviewPeriod
  /** Earliest authorized lifecycle evidence needed by this period, not just its first midnight. */
  historyStartUtcMsc: number
  asOfUtcMsc: number
}
export type PeriodReviewProgress = { phase: 'planning' } | {
  phase: 'history'; plan: PeriodReviewPlan; historyTaskId: string; historyAttempt: number
} | { phase: 'succeeded'; plan: PeriodReviewPlan; historyTaskId: string; caseIds: string[]; empty: boolean }
export interface PeriodReviewWorkflowPorts {
  authorize(scope: PeriodReviewScope): Promise<boolean>
  plan(scope: PeriodReviewScope, nowUtcMsc: number): Promise<PeriodReviewPlan | null>
  nextHistoryTaskId(): string
  request(scope: PeriodReviewScope, progress: Extract<PeriodReviewProgress,{phase:'history'}>): Promise<
    { status:'waiting'; reason:string } | { status:'unavailable'; reason:string } | { status:'failed' } | { status:'completed' }
  >
  collect(scope: PeriodReviewScope, progress: Extract<PeriodReviewProgress,{phase:'history'}>): Promise<
    { status:'unresolved'; reason:string } | { status:'empty' } | { status:'collected'; caseIds:string[] }
  >
}
export interface PeriodReviewTransition {
  progress: PeriodReviewProgress
  retryAfterMs: number | null
  reason: string | null
}
export interface PeriodReviewTaskRunner {
  run(id: string): Promise<{ status:'missing' } | { status:'advanced' | 'unchanged'; phase:PeriodReviewProgress['phase'] }>
}
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
function frozenPlan(scope: PeriodReviewScope, input: PeriodReviewPlan, now: number): PeriodReviewPlan {
  const value = structuredClone(input), period = freezeReviewPeriod(value.period,value.asOfUtcMsc)
  if (period.kind !== scope.kind || period.key !== scope.key || value.asOfUtcMsc > now
    || !Number.isSafeInteger(value.historyStartUtcMsc) || value.historyStartUtcMsc <= 0
    || value.historyStartUtcMsc > period.start.utcMsc) throw Error('period_workflow_plan_invalid')
  return { ...value, period }
}

/** Caller locks/persists each transition with its SQL effects. No provider or queue I/O belongs in these ports. */
export function createPeriodReviewWorkflow(ports: PeriodReviewWorkflowPorts) {
  return { async advance(input: PeriodReviewScope, stored: PeriodReviewProgress, nowUtcMsc: number): Promise<PeriodReviewTransition> {
    const scope = structuredClone(input), progress = structuredClone(stored)
    reviewPeriodCalendar(scope.kind,scope.key)
    if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || !/^[1-9]\d{0,19}$/.test(scope.accountId)
      || !scope.ownershipIntervalId || !Number.isSafeInteger(nowUtcMsc) || nowUtcMsc <= 0) throw Error('period_workflow_scope_invalid')
    if (!['planning','history','succeeded'].includes(progress.phase)) throw Error('period_workflow_progress_invalid')
    if (progress.phase !== 'planning') {
      progress.plan = frozenPlan(scope,progress.plan,nowUtcMsc)
      if (!uuid(progress.historyTaskId)) throw Error('period_workflow_progress_invalid')
    }
    if (progress.phase === 'succeeded') return { progress, retryAfterMs:null, reason:null }
    if (!await ports.authorize(scope)) return { progress, retryAfterMs:60_000, reason:'period_ownership_unavailable' }
    const newTaskId = () => { const id = ports.nextHistoryTaskId(); if (!uuid(id)) throw Error('period_workflow_task_id_invalid'); return id }
    if (progress.phase === 'planning') {
      const planned = await ports.plan(scope,nowUtcMsc)
      if (!planned) return { progress, retryAfterMs:60_000, reason:'period_plan_unavailable' }
      // Persist the frozen window and stable request identity before requesting collection on the next turn.
      return { progress:{ phase:'history',plan:frozenPlan(scope,planned,nowUtcMsc),historyTaskId:newTaskId(),historyAttempt:1 }, retryAfterMs:0, reason:null }
    }
    if (!Number.isSafeInteger(progress.historyAttempt) || progress.historyAttempt < 1) throw Error('period_workflow_progress_invalid')
    const requested = await ports.request(scope,progress)
    if (requested.status === 'failed') {
      const id = newTaskId()
      if (id === progress.historyTaskId || progress.historyAttempt === Number.MAX_SAFE_INTEGER) throw Error('period_workflow_task_id_invalid')
      return { progress:{ ...progress,historyTaskId:id,historyAttempt:progress.historyAttempt+1 },
        retryAfterMs:Math.min(3_600_000,60_000 * Math.pow(2,Math.min(progress.historyAttempt-1,6))),reason:'period_history_retry' }
    }
    if (requested.status !== 'completed') return { progress,retryAfterMs:60_000,reason:requested.reason }
    const collected = await ports.collect(scope,progress)
    if (collected.status === 'unresolved') return { progress,retryAfterMs:60_000,reason:collected.reason }
    if (collected.status === 'collected' && (!collected.caseIds.length || new Set(collected.caseIds).size !== collected.caseIds.length
      || collected.caseIds.some(id => !uuid(id)))) throw Error('period_workflow_cases_invalid')
    return { progress:{ phase:'succeeded',plan:progress.plan,historyTaskId:progress.historyTaskId,
      caseIds:collected.status === 'empty' ? [] : [...collected.caseIds],empty:collected.status === 'empty' },retryAfterMs:null,reason:null }
  } }
}
