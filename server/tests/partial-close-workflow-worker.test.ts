import { describe, expect, it, vi } from 'vitest'
import { createPartialCloseWorkflowWorker } from '../src/modules/execution/application/partial-close-workflow-worker.js'
import type { PartialCloseProgressResult } from '../src/modules/execution/application/partial-close-workflow-progress.js'
import type { PositionProtectionPreparationResult } from '../src/modules/execution/application/position-protection-preparation.js'
import type { PositionProtectionOutcomeService } from '../src/modules/execution/application/position-protection-outcome-service.js'
import { bridgeCommandId } from '../src/modules/execution/domain/bridge-command.js'

const scope = {workflowId:'11111111-1111-8111-a111-111111111111',userId:7,accountId:'5'}
const childIntentId = '22222222-2222-5222-a222-222222222222'
function fixture() {
  const current = {workflowId:scope.workflowId,revision:2,status:'risk_review_required',assessment:{state:'wait_close'},replayed:true} as PartialCloseProgressResult
  const prepared: PositionProtectionPreparationResult = {workflowId:scope.workflowId,revision:3,status:'protecting',childIntentId,rejectCode:null,replayed:false}
  const advance = vi.fn(async () => current), prepare = vi.fn(async () => prepared)
  return {advance,prepare,current,prepared,worker:createPartialCloseWorkflowWorker({advance},{prepare})}
}
describe('partial close workflow consumer orchestration', () => {
  it.each(['terminal_result_pending','receipt_pending','projection_pending','protection_not_observed'] as const)('waits on %s instead of preparing another dispatch', async reason => {
    const f=fixture(),merge=vi.fn(async()=>({outcome:{state:'waiting' as const,reason},revision:3,replayed:false}))
    const worker=createPartialCloseWorkflowWorker({advance:f.advance},{prepare:f.prepare},{merge})
    await expect(worker.run(scope)).resolves.toEqual({workflowId:scope.workflowId,state:'waiting',reason})
    expect(merge).toHaveBeenCalledExactlyOnceWith(scope)
  })
  it('returns uncertain commands only to reconciliation and rejects another command identity', async () => {
    const f=fixture(),commandId=bridgeCommandId(childIntentId,1)
    const merge=vi.fn<PositionProtectionOutcomeService['merge']>().mockResolvedValue({outcome:{state:'reconcile',commandId},revision:3,replayed:false})
    const worker=createPartialCloseWorkflowWorker({advance:f.advance},{prepare:f.prepare},{merge})
    await expect(worker.run(scope)).resolves.toEqual({workflowId:scope.workflowId,state:'protection_reconcile',childIntentId,commandId})
    merge.mockResolvedValue({outcome:{state:'reconcile',commandId:'other'},revision:3,replayed:false})
    await expect(worker.run(scope)).rejects.toThrow('partial_close_worker_state_invalid')
  })
  it('only queued commands return to the prepared receiver', async () => {
    const f=fixture(),merge:PositionProtectionOutcomeService['merge']=async()=>({outcome:{state:'waiting',reason:'command_queued'},revision:3,replayed:false})
    await expect(createPartialCloseWorkflowWorker({advance:f.advance},{prepare:f.prepare},{merge}).run(scope)).resolves.toMatchObject({state:'protection_prepared'})
  })
  it('advances qualification before preparing the protection child and returns its durable identity', async () => {
    const f=fixture()
    await expect(f.worker.run(scope)).resolves.toEqual({workflowId:scope.workflowId,state:'protection_prepared',childIntentId,replayed:false})
    expect(f.advance).toHaveBeenCalledExactlyOnceWith(scope);expect(f.prepare).toHaveBeenCalledExactlyOnceWith(scope)
    expect(f.advance.mock.invocationCallOrder[0]!).toBeLessThan(f.prepare.mock.invocationCallOrder[0]!)
  })
  it.each(['wait_close','reconcile_close','wait_history','wait_projection'] as const)('keeps %s waiting without risk preparation', async reason => {
    const f=fixture();f.advance.mockResolvedValue({...f.current,status:'awaiting_close',assessment:{state:reason}})
    await expect(f.worker.run(scope)).resolves.toEqual({workflowId:scope.workflowId,state:'waiting',reason})
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it.each(['stopped','expired'] as const)('does not reopen a %s workflow', async status => {
    const f=fixture();f.advance.mockResolvedValue({...f.current,status,revision:3})
    await expect(f.worker.run(scope)).resolves.toEqual({workflowId:scope.workflowId,state:status})
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it.each(['stopped','expired'] as const)('returns %s reached during preparation without inventing a child', async status => {
    const f=fixture();f.prepare.mockResolvedValue({...f.prepared,status,childIntentId:null})
    await expect(f.worker.run(scope)).resolves.toEqual({workflowId:scope.workflowId,state:status})
  })
  it('revalidates the stored child when an already-protecting workflow is redelivered', async () => {
    const f=fixture();f.advance.mockResolvedValue({...f.current,status:'protecting',revision:3});f.prepared.replayed=true
    await expect(f.worker.run(scope)).resolves.toMatchObject({state:'protection_prepared',childIntentId,replayed:true})
  })
  it('does not prepare a new command after verified workflow success', async () => {
    const f=fixture();f.advance.mockResolvedValue({...f.current,status:'succeeded',revision:4})
    await expect(f.worker.run(scope)).resolves.toEqual({workflowId:scope.workflowId,state:'succeeded'})
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it.each(['succeeded','stopped'] as const)('handles %s committed between progress and preparation', async status => {
    const f=fixture();f.prepare.mockResolvedValue({...f.prepared,status,revision:4,replayed:true,rejectCode:status==='stopped'?'position_absent':null})
    await expect(f.worker.run(scope)).resolves.toEqual({workflowId:scope.workflowId,state:status})
  })
  it('rejects success without a terminal workflow revision', async () => {
    const f=fixture();f.advance.mockResolvedValue({...f.current,status:'succeeded',revision:3})
    await expect(f.worker.run(scope)).rejects.toThrow('partial_close_worker_state_invalid')
    expect(f.prepare).not.toHaveBeenCalled()
  })
  it.each(['advance','prepare'] as const)('propagates %s uncertainty without retrying internally', async operation => {
    const f=fixture(),error=Error('commit_unknown');f[operation].mockRejectedValue(error)
    await expect(f.worker.run(scope)).rejects.toBe(error)
    expect(f[operation]).toHaveBeenCalledTimes(1)
  })
  it('rejects wrong workflow replies before requesting preparation', async () => {
    const f=fixture();f.advance.mockResolvedValue({...f.current,workflowId:'wrong'})
    await expect(f.worker.run(scope)).rejects.toThrow('partial_close_worker_state_invalid');expect(f.prepare).not.toHaveBeenCalled()
  })
  it('rejects malformed child results and backwards revisions', async () => {
    const f=fixture();f.prepared.childIntentId='invalid'
    await expect(f.worker.run(scope)).rejects.toThrow('partial_close_worker_state_invalid')
    f.prepared.childIntentId=childIntentId;f.prepared.revision=2
    await expect(f.worker.run(scope)).rejects.toThrow('partial_close_worker_state_invalid')
  })
  it('does not publish a prepared result carrying a risk rejection', async () => {
    const f=fixture();f.prepared.rejectCode='RISK_GLOBAL_KILL_SWITCH'
    await expect(f.worker.run(scope)).rejects.toThrow('partial_close_worker_state_invalid')
  })
  it('rejects invalid scopes without persistence access', async () => {
    const f=fixture()
    await expect(f.worker.run({...scope,accountId:'18446744073709551616'})).rejects.toThrow('partial_close_worker_state_invalid')
    expect(f.advance).not.toHaveBeenCalled()
  })
})
