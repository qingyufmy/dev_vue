import { expect, it, vi } from 'vitest'
import { createPeriodReviewWorkflow, type PeriodReviewWorkflowPorts, type PeriodReviewProgress } from '../src/modules/reviews/application/period-review-workflow.js'
const task = '00000000-0000-4000-8000-000000000001', next = '00000000-0000-4000-8000-000000000002'
const scope = { userId:7,accountId:'5',ownershipIntervalId:'interval',kind:'daily' as const,key:'2026-09-10' }
const start = Date.parse('2026-09-09T21:00:00.000Z'), end = start+86400000, now = end+60_000
const plan = { period:{kind:scope.kind,key:scope.key,start:{utcMsc:start,offsetMinutes:180,evidenceRef:'clock:start'},
  end:{utcMsc:end,offsetMinutes:180,evidenceRef:'clock:end'}},historyStartUtcMsc:start-86400000,asOfUtcMsc:now }
const progress = (): PeriodReviewProgress => ({phase:'history',plan:structuredClone(plan),historyTaskId:task,historyAttempt:1})
function fixture() {
  const ports = { authorize:vi.fn(async()=>true),plan:vi.fn(async()=>structuredClone(plan)),nextHistoryTaskId:vi.fn(()=>next),
    request:vi.fn<PeriodReviewWorkflowPorts['request']>(async()=>({status:'completed'})),
    collect:vi.fn<PeriodReviewWorkflowPorts['collect']>(async()=>({status:'collected',caseIds:[task]})) }
  return {ports,workflow:createPeriodReviewWorkflow(ports)}
}
it('freezes the full lifecycle window before any history request is made',async()=>{
  const {ports,workflow}=fixture()
  const result=await workflow.advance(scope,{phase:'planning'},now)
  expect(result).toEqual({progress:{phase:'history',plan,historyTaskId:next,historyAttempt:1},retryAfterMs:0,reason:null})
  expect(ports.request).not.toHaveBeenCalled();expect(ports.collect).not.toHaveBeenCalled()
})
it('keeps the original window and task identity while another history task is active',async()=>{
  const {ports,workflow}=fixture(),original=progress()
  ports.request.mockResolvedValue({status:'waiting',reason:'history_account_busy'})
  expect((await workflow.advance(scope,original,now+3600000)).progress).toEqual(original)
  expect(ports.plan).not.toHaveBeenCalled();expect(ports.nextHistoryTaskId).not.toHaveBeenCalled();expect(ports.collect).not.toHaveBeenCalled()
})
it('renews only the failed history attempt identity, with bounded backoff and unchanged range',async()=>{
  const {ports,workflow}=fixture(),original=progress()
  ports.request.mockResolvedValue({status:'failed'})
  const result=await workflow.advance(scope,original,now)
  expect(result).toEqual({progress:{...original,historyTaskId:next,historyAttempt:2},retryAfterMs:60000,reason:'period_history_retry'})
  expect(original).toEqual(progress());expect(ports.collect).not.toHaveBeenCalled()
})
it('does not re-activate a completed workflow or invoke its effect ports',async()=>{
  const {ports,workflow}=fixture()
  const done=await workflow.advance(scope,progress(),now)
  expect(done.progress.phase).toBe('succeeded')
  ports.request.mockClear();ports.collect.mockClear();ports.authorize.mockClear()
  expect(await workflow.advance(scope,done.progress,now+1000)).toEqual(done)
  expect(ports.request).not.toHaveBeenCalled();expect(ports.collect).not.toHaveBeenCalled();expect(ports.authorize).not.toHaveBeenCalled()
})
it('retains unresolved inventory and permits an explicitly empty verified period',async()=>{
  const {ports,workflow}=fixture(),original=progress()
  ports.collect.mockResolvedValue({status:'unresolved',reason:'period_inventory_incomplete'})
  expect(await workflow.advance(scope,original,now)).toEqual({progress:original,retryAfterMs:60000,reason:'period_inventory_incomplete'})
  ports.collect.mockResolvedValue({status:'empty'})
  expect((await workflow.advance(scope,original,now)).progress).toMatchObject({phase:'succeeded',caseIds:[],empty:true})
})
it('rejects mismatched, future or truncated plans and invalid successful case lists',async()=>{
  const {ports,workflow}=fixture()
  for(const bad of [{...plan,historyStartUtcMsc:start+1},{...plan,asOfUtcMsc:now+1},
    {...plan,period:{...plan.period,key:'2026-09-09'}}]) {
    ports.plan.mockResolvedValue(bad)
    await expect(workflow.advance(scope,{phase:'planning'},now)).rejects.toThrow()
  }
  ports.collect.mockResolvedValue({status:'collected',caseIds:[]})
  await expect(workflow.advance(scope,progress(),now)).rejects.toThrow('period_workflow_cases_invalid')
})
it('denies revoked ownership before any planning or request, and propagates errors for rollback',async()=>{
  const {ports,workflow}=fixture()
  ports.authorize.mockResolvedValue(false)
  expect((await workflow.advance(scope,progress(),now)).reason).toBe('period_ownership_unavailable')
  expect(ports.request).not.toHaveBeenCalled()
  ports.authorize.mockResolvedValue(true);ports.request.mockRejectedValue(Error('db_failed'))
  await expect(workflow.advance(scope,progress(),now)).rejects.toThrow('db_failed')
})
