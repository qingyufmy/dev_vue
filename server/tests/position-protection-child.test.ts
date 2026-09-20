import { describe, expect, it } from 'vitest'
import { preparePositionProtectionChild, positionProtectionRequest, type PositionProtectionReview } from '../src/modules/execution/domain/position-protection-child.js'
import { sha256Canonical } from '../src/modules/execution/domain/execution.js'
import { bridgeCommandId, createBridgeCommand } from '../src/modules/execution/domain/bridge-command.js'
import { bindPositionProtectionCommand } from '../src/modules/execution/domain/position-protection-command-binding.js'
import { reviewPositionProtectionCommand } from '../src/modules/execution/domain/position-protection-command-review.js'
import { reviewPositionProtectionDispatch } from '../src/modules/execution/domain/position-protection-dispatch-review.js'
import { evaluatePositionProtectionOutcome } from '../src/modules/execution/domain/position-protection-outcome.js'
import { evaluatePartialCloseProtection, type PartialCloseProtectionPlan } from '../src/modules/execution/domain/partial-close-protection.js'

const now = new Date('2026-09-10T10:00:00.123Z'), at = now.getTime()
function fixture() {
  const plan: PartialCloseProtectionPlan = { workflowId: '11111111-1111-8111-a111-111111111111',
    parentIntentId: '22222222-2222-5222-a222-222222222222', parentCommandId: 'parent-command',
    target: { userId: '7', accountId: '5', terminalInstanceId: 'terminal', brokerServer: 'Broker', login: '42',
      ticket: '101', positionIdentifier: '100', symbol: 'XAUUSD', side: 'buy' },
    initialVolume: '0.10', closeVolume: '0.08', initialRevision: 5, expiresAt: at + 60000,
    protection: { stopLoss: '2450', takeProfit: '2600' } }
  const ready = evaluatePartialCloseProtection({ plan, parentState: 'succeeded',
    history: { parentIntentId: plan.parentIntentId, parentCommandId: plan.parentCommandId, target: plan.target, closedVolume: '0.08', completedAt: at - 100 },
    projection: { route: plan.target, complete: true, revision: 6, observedAt: at - 50, positions: [{ target: plan.target, volume: '0.02' }] },
    now: at, maxProjectionAgeMs: 1000 })
  if (ready.state !== 'risk_review_required') throw new Error('fixture_not_ready')
  const request = positionProtectionRequest(plan, ready, 2), actionId = `protection:${plan.workflowId}:2`
  const review: PositionProtectionReview = { workflowId: plan.workflowId, workflowRevision: 2,
    requestHash: sha256Canonical(request), contextHash: 'a'.repeat(64),
    evaluation: { status: 'approved', rejectCode: null, policyHash: 'b'.repeat(64), evaluatedAt: now.toISOString(),
      manualReleaseId: null, manualReleaseRevision: null,
      rules: [{ code: 'RISK_POSITION_PROTECTION_APPROVED', outcome: 'passed', actionId, details: {} }],
      approvedActions: [{ actionId, kind: 'modify_position', parameters: { ticket: '101', stop_loss: '2450', take_profit: '2600' },
        expectedState: { accountRevision: 2, positionsRevision: 6, quoteRevision: 8, contractRevision: 3, riskRevision: 4 } }] } }
  return { plan, ready, review, revision: 2, parentOperationId: '33333333-3333-5333-a333-333333333333', now }
}
describe('position protection child preparation', () => {
  it('binds a unique child to the workflow without AI or user-command lineage', () => {
    const f = fixture(), child = preparePositionProtectionChild(f)
    expect(child.intent).toMatchObject({ sourceType: 'position_workflow', sourceId: f.plan.workflowId, actionKind: 'modify_position',
      riskDecisionId: null, tradeDecisionId: null, userCommandId: null, riskReservationId: null })
    expect(child.operation.parentOperationId).toBe(f.parentOperationId)
    expect(child.operation.intentIds).toEqual([child.intent.id])
    expect(bridgeCommandId(child.intent.id, 1)).toMatch(/^cmd_/)
    expect(preparePositionProtectionChild(f)).toEqual(child)
    f.review.evaluation.approvedActions[0]!.parameters.stop_loss = '1'
    expect(child.intent.action.parameters.stop_loss).toBe('2450')
  })
  it('keeps identities stable across re-review while changing the source hash', () => {
    const f = fixture(), first = preparePositionProtectionChild(f)
    f.review.contextHash = 'c'.repeat(64)
    const next = preparePositionProtectionChild(f)
    expect(next.intent.id).toBe(first.intent.id)
    expect(next.operation.id).toBe(first.operation.id)
    expect(next.intent.idempotencyKey).toBe(first.intent.idempotencyKey)
    expect(next.intent.requestHash).not.toBe(first.intent.requestHash)
    f.revision = 3
    f.review.workflowRevision = 3
    f.review.requestHash = sha256Canonical(positionProtectionRequest(f.plan, f.ready, 3))
    f.review.evaluation.approvedActions[0]!.actionId = `protection:${f.plan.workflowId}:3`
    f.review.evaluation.rules[0]!.actionId = `protection:${f.plan.workflowId}:3`
    expect(preparePositionProtectionChild(f).intent.id).toBe(first.intent.id)
  })
  it.each(['target','quantity','revision','price'] as const)('rejects changed persisted eligibility %s', field => {
    const f = fixture()
    if (field === 'target') f.ready = { ...f.ready, target: { ...f.ready.target, ticket: '102' } }
    if (field === 'quantity') f.ready = { ...f.ready, remainingVolume: '0.020000000000000001' }
    if (field === 'revision') f.ready = { ...f.ready, projectionRevision: 5 }
    if (field === 'price') f.ready = { ...f.ready, protection: { stopLoss: '2400' } }
    expect(() => preparePositionProtectionChild(f)).toThrow('position_protection_review_mismatch')
  })
  it.each(['request','workflow','context','policy','manual','rejected','actions','kind','ticket','price','extra','state','rule'] as const)('rejects unbound review %s', field => {
    const f = fixture(), e = f.review.evaluation, a = e.approvedActions[0]!
    if (field === 'request') f.review.requestHash = 'c'.repeat(64)
    if (field === 'workflow') f.review.workflowRevision++
    if (field === 'context') f.review.contextHash = ''
    if (field === 'policy') e.policyHash = ''
    if (field === 'manual') e.manualReleaseId = 'release'
    if (field === 'rejected') e.status = 'rejected'
    if (field === 'actions') e.approvedActions.push(structuredClone(a))
    if (field === 'kind') a.kind = 'market_order'
    if (field === 'ticket') a.parameters.ticket = '102'
    if (field === 'price') a.parameters.stop_loss = '2400'
    if (field === 'extra') a.parameters.volume = '1'
    if (field === 'state') a.expectedState.positionsRevision = 5
    if (field === 'rule') e.rules[0]!.outcome = 'rejected'
    expect(() => preparePositionProtectionChild(f)).toThrow('position_protection_review_mismatch')
  })
  it('caps expiry at both the original plan and the review preparation window', () => {
    const f = fixture()
    expect(preparePositionProtectionChild(f).intent.expiresAt).toBe(new Date(at + 30000).toISOString())
    f.plan = { ...f.plan, expiresAt: at + 1000 }
    f.review.requestHash = sha256Canonical(positionProtectionRequest(f.plan, f.ready, f.revision))
    expect(preparePositionProtectionChild(f).intent.expiresAt).toBe(new Date(at + 1000).toISOString())
    f.now = new Date(at + 1000)
    expect(() => preparePositionProtectionChild(f)).toThrow('position_protection_review_mismatch')
  })
  it.each([-1, 30000])('rejects future or stale risk review at offset %s', offset => {
    const f = fixture()
    f.now = new Date(at + offset)
    expect(() => preparePositionProtectionChild(f)).toThrow('position_protection_review_mismatch')
  })
})

describe('position protection current command review', () => {
  it('accepts newer current facts while preserving the original child receipt and deadline', () => {
    const child=preparePositionProtectionChild(fixture()),before=structuredClone(child),review=structuredClone(child.review)
    review.contextHash='c'.repeat(64);review.evaluation.evaluatedAt=new Date(at+1).toISOString()
    review.evaluation.approvedActions[0]!.expectedState.positionsRevision=7
    review.evaluation.approvedActions[0]!.expectedState.quoteRevision=9
    const result=reviewPositionProtectionCommand(child,review,new Date(at+2))
    expect(result.childIntentId).toBe(child.intent.id)
    expect(result.sourceRequestHash).toBe(child.intent.requestHash)
    expect(result.preparationReviewHash).toBe(child.reviewHash)
    expect(result.action.expectedState.positionsRevision).toBe(7)
    expect(result.expiresAt).toBe(child.intent.expiresAt)
    expect(child).toEqual(before)
    review.evaluation.approvedActions[0]!.parameters.stop_loss='1'
    expect(result.action.parameters.stop_loss).toBe('2450')
  })
  it.each(['scope','price','ticket','kind','manual','rejected','regression','extra','future','rule'] as const)('rejects invalid command re-review %s', field => {
    const child=preparePositionProtectionChild(fixture()),review=structuredClone(child.review),evaluation=review.evaluation,action=evaluation.approvedActions[0]!
    if(field==='scope')review.requestHash='c'.repeat(64)
    if(field==='price')action.parameters.stop_loss='2400'
    if(field==='ticket')action.parameters.ticket='102'
    if(field==='kind')action.kind='close_position'
    if(field==='manual')evaluation.manualReleaseId='release'
    if(field==='rejected')evaluation.status='rejected'
    if(field==='regression')action.expectedState.quoteRevision=7
    if(field==='extra')action.parameters.volume='1'
    if(field==='future')evaluation.evaluatedAt=new Date(at+1000).toISOString()
    if(field==='rule')evaluation.rules[0]!.outcome='rejected'
    expect(()=>reviewPositionProtectionCommand(child,review,new Date(at+1))).toThrow('position_protection_command_review_invalid')
  })
  it('cannot extend an expired child even with a fresh approved review', () => {
    const child=preparePositionProtectionChild(fixture()),review=structuredClone(child.review)
    review.evaluation.evaluatedAt=child.intent.expiresAt
    expect(()=>reviewPositionProtectionCommand(child,review,new Date(child.intent.expiresAt))).toThrow('position_protection_command_review_invalid')
  })
})

describe('protection command binding', () => {
  function bindingFixture() {
    const f=fixture()
    f.plan={...f.plan,target:{...f.plan.target,terminalInstanceId:'terminal-1'}}
    f.ready={...f.ready,target:{...f.plan.target}}
    f.review.requestHash=sha256Canonical(positionProtectionRequest(f.plan,f.ready,2))
    const child=preparePositionProtectionChild(f),authority=reviewPositionProtectionCommand(child,child.review,now)
    const command=createBridgeCommand({executionIntentId:child.intent.id,commandSequence:1,userId:7,accountId:'5',terminalProfileId:'profile-1',
      route:{terminalInstanceId:'terminal-1',brokerServer:'Broker',login:'42',connectionEpoch:1},action:'position.protection.set',
      params:authority.action.parameters,expectedState:{ticket:'101',symbol:'XAUUSD',direction:'buy',volume:'0.02',order_type:'market',magic:0,
        open_price:'2450',stop_limit_price:null,stop_loss:'2400',take_profit:null,expiration_utc_msc:null},deadlineAt:child.intent.expiresAt},now)
    return {child,authority,command}
  }
  it('binds deterministic command identity, reviewed authority and exact residual position', () => {
    const f=bindingFixture(),binding=bindPositionProtectionCommand(f.child,f.authority,f.command,now)
    expect(binding).toMatchObject({workflowId:f.child.request.workflowId,childIntentId:f.child.intent.id,bridgeCommandId:f.command.id,
      commandHash:f.command.requestHash,authorityHash:sha256Canonical(f.authority)})
  })
  function outcomeFixture(): Parameters<typeof evaluatePositionProtectionOutcome>[0] {
    const f = bindingFixture(), command = { ...f.command, status: 'succeeded' as const, revision: 4,
      dispatchedAt: new Date(at + 1).toISOString(), completedAt: new Date(at + 2).toISOString(), resultHash: 'f'.repeat(64) }
    const target = { ...f.child.request.target, userId: '7', accountId: '5' }
    return { child: f.child, command, dispatchedPositionRevision: 7, now: at + 100, maxProjectionAgeMs: 1000,
      receipt: { commandId: command.id, childIntentId: f.child.intent.id, requestHash: command.requestHash, resultHash: command.resultHash, completedAt: at + 2 },
      projection: { route: target, complete: true, revision: 8, observedAt: at + 3,
        positions: [{ target, volume: '0.02', stopLoss: '2450.00', takeProfit: '2600' }] } }
  }
  it('requires a confirmed receipt and newer complete projection with applied protection', () => {
    const f = outcomeFixture()
    expect(evaluatePositionProtectionOutcome(f).state).toBe('succeeded')
    f.receipt = null
    expect(evaluatePositionProtectionOutcome(f)).toEqual({ state: 'waiting', reason: 'receipt_pending' })
  })
  it.each(['uncertain', 'reconciling'] as const)('keeps %s visible after intent expiry', status => {
    const f = outcomeFixture(); f.command.status = status; f.now += 60000
    expect(evaluatePositionProtectionOutcome(f)).toEqual({ state: 'reconcile', commandId: f.command.id })
  })
  it('can confirm a sent command after the original preparation deadline', () => {
    const f = outcomeFixture(); f.now += 60000; f.projection = { ...f.projection!, observedAt: f.now }
    expect(evaluatePositionProtectionOutcome(f).state).toBe('succeeded')
  })
  it.each(['missing', 'old-version', 'old-time', 'future', 'incomplete'] as const)('waits for usable projection: %s', mode => {
    const f = outcomeFixture(), p = f.projection!
    if (mode === 'missing') f.projection = null
    if (mode === 'old-version') f.projection = { ...p, revision: 7 }
    if (mode === 'old-time') f.projection = { ...p, observedAt: at }
    if (mode === 'future') f.projection = { ...p, observedAt: f.now + 1 }
    if (mode === 'incomplete') f.projection = { ...p, complete: false }
    expect(evaluatePositionProtectionOutcome(f)).toEqual({ state: 'waiting', reason: 'projection_pending' })
  })
  it.each([undefined, null, '2400'])('does not accept absent or mismatched stop loss %s', stopLoss => {
    const f = outcomeFixture(), position = { ...f.projection!.positions[0]! }
    if (stopLoss === undefined) delete position.stopLoss
    else position.stopLoss = stopLoss
    f.projection = { ...f.projection!, positions: [position] }
    expect(evaluatePositionProtectionOutcome(f)).toEqual({ state: 'waiting', reason: 'protection_not_observed' })
  })
  it('preserves unrequested take profit and rejects wrong receipt lineage', () => {
    const f = outcomeFixture()
    delete f.command.request.payload.params.take_profit
    delete f.child.intent.action.parameters.take_profit
    expect(evaluatePositionProtectionOutcome(f).state).toBe('waiting')
    f.receipt!.commandId = 'other'
    expect(() => evaluatePositionProtectionOutcome(f)).toThrow('position_protection_outcome_evidence_invalid')
  })
  it('does not label an absent or changed position as protection success', () => {
    const f = outcomeFixture(), p = f.projection!
    f.projection = { ...p, positions: [] }
    expect(evaluatePositionProtectionOutcome(f)).toEqual({ state: 'stopped', reason: 'position_absent' })
    f.projection = { ...p, positions: [{ ...p.positions[0]!, volume: '0.01' }] }
    expect(evaluatePositionProtectionOutcome(f)).toEqual({ state: 'stopped', reason: 'position_changed' })
  })
  it('binds a request created before the transaction review using the later binding clock', () => {
    const f = bindingFixture(), review = structuredClone(f.child.review)
    review.evaluation.evaluatedAt = new Date(at + 10).toISOString()
    const authority = reviewPositionProtectionCommand(f.child, review, new Date(at + 11))
    expect(bindPositionProtectionCommand(f.child, authority, f.command, new Date(at + 12)).bridgeCommandId).toBe(f.command.id)
    expect(() => bindPositionProtectionCommand(f.child, authority, f.command, now)).toThrow()
  })
  it('reviews a queued command against newer facts without rewriting its original binding', () => {
    const f = bindingFixture(), binding = bindPositionProtectionCommand(f.child, f.authority, f.command, now)
    const before = structuredClone(binding), review = structuredClone(f.child.review)
    review.evaluation.evaluatedAt = new Date(at + 10).toISOString()
    review.evaluation.approvedActions[0]!.expectedState.positionsRevision = 9
    const current = reviewPositionProtectionCommand(f.child, review, new Date(at + 11))
    const result = reviewPositionProtectionDispatch(f.child, f.command, binding, now, current, new Date(at + 12))
    expect(result.creationBindingHash).toBe(sha256Canonical(binding))
    expect(result.authority.action.expectedState.positionsRevision).toBe(9)
    expect(binding).toEqual(before)
  })
  it.each(['regression', 'review-time', 'status', 'binding', 'deadline'] as const)('rejects invalid dispatch %s', field => {
    const f = bindingFixture(), originalReview = structuredClone(f.child.review)
    originalReview.evaluation.evaluatedAt = new Date(at + 10).toISOString()
    originalReview.evaluation.approvedActions[0]!.expectedState.positionsRevision = 8
    const boundAt = new Date(at + 11), later = new Date(at + 20)
    const authority = reviewPositionProtectionCommand(f.child, originalReview, boundAt)
    const binding = bindPositionProtectionCommand(f.child, authority, f.command, boundAt)
    const review = structuredClone(originalReview)
    review.evaluation.evaluatedAt = new Date(at + 15).toISOString()
    if (field === 'regression') review.evaluation.approvedActions[0]!.expectedState.positionsRevision = 7
    if (field === 'review-time') review.evaluation.evaluatedAt = new Date(at + 5).toISOString()
    const current = reviewPositionProtectionCommand(f.child, review, later)
    if (field === 'status') f.command.status = 'uncertain'
    if (field === 'binding') binding.commandHash = 'bad'
    if (field === 'deadline') later.setTime(Date.parse(f.command.deadlineAt))
    expect(() => reviewPositionProtectionDispatch(f.child, f.command, binding, boundAt, current, later)).toThrow()
  })
  it.each(['route','volume','price','hash','envelope','sequence','expiry'] as const)('rejects inconsistent %s before persistence', field => {
    const f=bindingFixture()
    if(field==='route')f.command.route.login='43'
    if(field==='volume')f.command.request.payload.expected_state!.volume='0.01'
    if(field==='price')f.command.request.payload.params.stop_loss='1'
    if(field==='hash')f.command.requestHash='a'.repeat(64)
    if(field==='envelope')f.command.request.correlation_id='different'
    if(field==='sequence')f.command.commandSequence=2
    if(field==='expiry')f.command.deadlineAt=new Date(at+60000).toISOString()
    expect(()=>bindPositionProtectionCommand(f.child,f.authority,f.command,now)).toThrow()
  })
})
