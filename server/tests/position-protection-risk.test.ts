import { describe, expect, it, vi } from 'vitest'
import { evaluatePartialCloseDispatch } from '../src/modules/risk/domain/partial-close-dispatch-risk.js'
import { createPositionProtectionReviewer, evaluatePositionProtection, DEFAULT_RISK_POLICY, resolveRiskPolicy,
  type PositionProtectionRiskContext, type PositionProtectionRiskRequest } from '../src/modules/risk/index.js'

const now = new Date('2026-09-10T10:00:00.123Z'), at = now.getTime()
function fixture() {
  const target = {terminalInstanceId:'terminal',brokerServer:'Broker',login:'42',ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy' as const}
  const request: PositionProtectionRiskRequest = {workflowId:'11111111-1111-8111-a111-111111111111',workflowRevision:2,userId:7,accountId:'5',target,
    remainingVolume:'0.02',minimumPositionRevision:6,notBefore:at-100,expiresAt:at+1000,protection:{stopLoss:'2450',takeProfit:'2600'}}
  const context: PositionProtectionRiskContext = {userId:7,accountId:'5',authorized:true,connectionPaused:false,tradePermission:true,collectionComplete:true,accountObservedAt:now.toISOString(),
    policy:resolveRiskPolicy({accountId:'5',userId:7,platformPolicyVersionId:'1',accountPolicyVersionId:null,policySetRevision:1,
      platform:{values:{...DEFAULT_RISK_POLICY},globalKillSwitch:false,revision:1},account:{tradeSendEnabled:true},updatedAt:now.toISOString()}),
    summary:{accountId:'5',userId:7,businessDate:'2026-09-10',equity:'10000',freeMargin:'9000',marginLevelPercent:1000,
      dailyLossPercent:1,drawdownPercent:1,openPositions:1,pendingOrders:0,totalVolume:'0.02',dailyOpenCount:1,consecutiveLosses:0,
      terminalTimezoneOffsetMinutes:180,clockStatus:'calibrated',lastSuccessfulOpenAt:null,cooldownUntil:null,dataComplete:true,incompleteReasons:[],observedAt:now.toISOString(),revision:4},
    quote:{symbol:'XAUUSD',bid:'2500',ask:'2500.10',observedAt:now.toISOString(),revision:8},
    instrument:{symbol:'XAUUSD',point:'0.01',tickSize:'0.01',tradeEnabled:true,revision:3,observedAt:now.toISOString(),maxAgeMs:300000},
    position:{...target,volume:'0.020',stopLoss:'2400',takeProfit:'2700',revision:6,observedAt:now.toISOString()},
    revisions:{account:2,positions:6,quote:8,contract:3,risk:4}}
  return {request,context}
}
const evaluate = (f: ReturnType<typeof fixture>) => evaluatePositionProtection(f.request,f.context,now)
describe('opaque broker login identity', () => {
  it.each(['001', 'demo-account'])('preserves valid login %s without numeric coercion', login => {
    const f = fixture()
    const request = { ...f.request, target: { ...f.request.target, login } }
    const context = { ...f.context, position: { ...f.context.position, login } }
    expect(evaluatePositionProtection(request, context, now).evaluation.status).toBe('approved')
    expect(evaluatePositionProtection(request, { ...context, position: { ...context.position, login: '1' } }, now).evaluation.rejectCode).toBe('RISK_PROTECTION_TARGET_MISMATCH')
    const parentRequest = { workflowId: request.workflowId, userId: request.userId, accountId: request.accountId, target: request.target,
      initialVolume: '0.02', closeVolume: '0.01', positionRevision: 6, notBefore: request.notBefore, expiresAt: request.expiresAt }
    const parentContext = { ...context, instrument: { ...context.instrument, volumeMin: '0.01', volumeMax: '10', volumeStep: '0.01' } }
    expect(evaluatePartialCloseDispatch(parentRequest, parentContext, now).status).toBe('approved')
    expect(evaluatePartialCloseDispatch(parentRequest, { ...parentContext, position: { ...context.position, login: '1' } }, now).rejectCode).toBe('RISK_PARTIAL_CLOSE_TARGET_MISMATCH')
  })
  it.each(['', ' ', 'a\n', 'x'.repeat(65)])('rejects invalid login length or controls', login => {
    const f = fixture(), target = { ...f.request.target, login }
    expect(() => evaluatePositionProtection({ ...f.request, target }, f.context, now)).toThrow('position_protection_request_invalid')
    expect(() => evaluatePartialCloseDispatch({ workflowId: f.request.workflowId, userId: 7, accountId: '5', target,
      initialVolume: '0.02', closeVolume: '0.01', positionRevision: 6, notBefore: at - 100, expiresAt: at + 30000 },
    { ...f.context, instrument: { ...f.context.instrument, volumeMin: '0.01', volumeMax: '10', volumeStep: '0.01' } }, now)).toThrow('partial_close_dispatch_request_invalid')
  })
})
describe('parent close-with-continuation current risk admission', () => {
  function parent() {
    const f = fixture()
    const request = { workflowId: f.request.workflowId, userId: 7, accountId: '5', target: f.request.target,
      initialVolume: '0.02', closeVolume: '0.01', positionRevision: 6, notBefore: at - 100, expiresAt: at + 1000 }
    const context = { ...f.context, position: { ...f.context.position }, quote: { ...f.context.quote },
      instrument: { ...f.context.instrument, volumeMin: '0.01', volumeMax: '100', volumeStep: '0.01' } }
    return { request, context, run: () => evaluatePartialCloseDispatch(request,context,now) }
  }
  it('approves the frozen exact reduction and leaves later protection to a separate review', () => {
    const f = parent()
    f.context.summary.dailyLossPercent = 99
    expect(f.run()).toMatchObject({ status: 'approved', volume: '0.01', remainingVolume: '0.01' })
    expect(f.run()).not.toHaveProperty('approvedActions')
  })
  it.each(['global','account','paused','incomplete','uncalibrated'])('rejects current %s control', gate => {
    const f = parent()
    if (gate === 'global') f.context.policy.globalKillSwitch = true
    if (gate === 'account') f.context.policy.values.accountKillSwitch = true
    if (gate === 'paused') f.context.connectionPaused = true
    if (gate === 'incomplete') f.context.summary.dataComplete = false
    if (gate === 'uncalibrated') f.context.summary.clockStatus = 'stale'
    expect(f.run().status).toBe('rejected')
  })
  it.each(['account','position','quote','instrument'])('rejects stale %s facts', field => {
    const f = parent(), stale = new Date(at - 600000).toISOString()
    if (field === 'account') f.context.accountObservedAt = stale
    if (field === 'position') f.context.position.observedAt = stale
    if (field === 'quote') f.context.quote.observedAt = stale
    if (field === 'instrument') f.context.instrument.observedAt = stale
    expect(f.run().status).toBe('rejected')
  })
  it.each(['0.02','0.001','0.03'])('rejects full, off-step or excessive close volume %s', volume => {
    const f = parent(); f.request.closeVolume = volume
    expect(f.run().rejectCode).toBe('RISK_PARTIAL_CLOSE_LIMITS_INVALID')
  })
  it('rejects a changed original position volume and exact revision', () => {
    const f = parent(); f.context.position.volume = '0.03'
    expect(f.run().rejectCode).toBe('RISK_PARTIAL_CLOSE_VOLUME_CHANGED')
    f.context.position.volume = '0.02'; f.context.position.revision++
    expect(f.run().rejectCode).toBe('RISK_EXPECTED_STATE_STALE')
  })
})
describe('current position protection risk review', () => {
  it('approves only the frozen prices with current revisions and separate workflow hashes', () => {
    const f=fixture(), before=structuredClone(f), review=evaluate(f)
    expect(review.evaluation.status).toBe('approved')
    expect(review.evaluation.approvedActions).toEqual([{actionId:`protection:${f.request.workflowId}:2`,kind:'modify_position',
      parameters:{ticket:'101',stop_loss:'2450',take_profit:'2600'},expectedState:{accountRevision:2,positionsRevision:6,quoteRevision:8,contractRevision:3,riskRevision:4}}])
    expect(review.requestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(review.contextHash).toMatch(/^[0-9a-f]{64}$/)
    expect(review.evaluation.manualReleaseId).toBeNull()
    expect(f).toEqual(before)
  })
  it('does not turn opening limits or historical losses into a block on reducing existing exposure', () => {
    const f=fixture()
    f.context.summary.dailyLossPercent=99;f.context.summary.drawdownPercent=99;f.context.summary.dailyOpenCount=999
    f.context.policy.values.maxOpenPositions=0;f.context.policy.values.maxOrderVolume=0.01
    expect(evaluate(f).evaluation.status).toBe('approved')
  })
  it.each([
    ['authorized',false],['connectionPaused',true],['tradePermission',false],
  ] as const)('rejects current access gate %s', (field,value) => {
    const f=fixture(), context={...f.context,[field]:value}
    expect(evaluatePositionProtection(f.request,context,now).evaluation.rejectCode).toBe('RISK_PROTECTION_ACCESS_UNAVAILABLE')
  })
  it.each(['global','account'] as const)('applies %s halt even to tightening protection', gate => {
    const f=fixture()
    if(gate==='global')f.context.policy.globalKillSwitch=true
    if(gate==='account')f.context.policy.values.accountKillSwitch=true
    expect(evaluate(f).evaluation.rejectCode).toBe({global:'RISK_GLOBAL_KILL_SWITCH',account:'RISK_ACCOUNT_KILL_SWITCH'}[gate])
  })
  it('does not use the legacy send-permission value as a protection gate', () => {
    const f=fixture(); f.context.policy.values.tradeSendEnabled=false
    expect(evaluate(f).evaluation.status).toBe('approved')
  })
  it.each(['terminalInstanceId','brokerServer','login','ticket','positionIdentifier','symbol','side'] as const)('rejects changed target %s', field => {
    const f=fixture(), position={...f.context.position,[field]:field==='side'?'sell':'other'} as PositionProtectionRiskContext['position']
    expect(evaluatePositionProtection(f.request,{...f.context,position},now).evaluation.rejectCode).toBe('RISK_PROTECTION_TARGET_MISMATCH')
  })
  it('rejects stale or mismatched revisions and changed residual quantities', () => {
    const f=fixture()
    expect(evaluatePositionProtection(f.request,{...f.context,position:{...f.context.position,revision:5}},now).evaluation.rejectCode).toBe('RISK_EXPECTED_STATE_STALE')
    expect(evaluatePositionProtection(f.request,{...f.context,position:{...f.context.position,volume:'0.020000000000000001'}},now).evaluation.rejectCode).toBe('RISK_PROTECTION_VOLUME_CHANGED')
    f.context.summary.revision++
    expect(evaluate(f).evaluation.rejectCode).toBe('RISK_EXPECTED_STATE_STALE')
  })
  it.each(['position','summary','quote'] as const)('requires fresh nonfuture %s facts', source => {
    const f=fixture()
    for(const time of [at-60000,at+1]) {
      const context={...f.context,[source]:{...f.context[source],observedAt:new Date(time).toISOString()}}
      expect(evaluatePositionProtection(f.request,context,now).evaluation.rejectCode).toBe({position:'RISK_POSITION_STALE',summary:'RISK_SUMMARY_STALE',quote:'RISK_QUOTE_STALE'}[source])
    }
  })
  it('rejects expired requests, incomplete data and unverified terminal clocks', () => {
    const f=fixture()
    expect(evaluatePositionProtection({...f.request,expiresAt:at},f.context,now).evaluation.rejectCode).toBe('RISK_PROTECTION_REQUEST_EXPIRED')
    expect(evaluatePositionProtection(f.request,{...f.context,collectionComplete:false},now).evaluation.rejectCode).toBe('RISK_DATA_INCOMPLETE')
    f.context.summary.clockStatus='stale'
    expect(evaluate(f).evaluation.rejectCode).toBe('RISK_TERMINAL_CLOCK_UNVERIFIED')
  })
  it.each([
    [{stopLoss:'2399'},'RISK_PROTECTION_STOP_WIDENING'],[{stopLoss:'2500'},'RISK_STOP_LOSS_DIRECTION_INVALID'],
    [{takeProfit:'2499'},'RISK_TAKE_PROFIT_DIRECTION_INVALID'],[{stopLoss:'2450.001'},'RISK_PROTECTION_PRICE_OFF_TICK'],
  ] as const)('rejects invalid requested protection %j', (protection,code) => {
    const f=fixture()
    expect(evaluatePositionProtection({...f.request,protection},f.context,now).evaluation.rejectCode).toBe(code)
  })
  it('checks sell protection against ask and refuses to widen the existing sell stop', () => {
    const f=fixture(), request={...f.request,target:{...f.request.target,side:'sell' as const},protection:{stopLoss:'2550',takeProfit:'2400'}},
      context={...f.context,position:{...f.context.position,side:'sell' as const,stopLoss:'2600'}}
    expect(evaluatePositionProtection(request,context,now).evaluation.status).toBe('approved')
    expect(evaluatePositionProtection({...request,protection:{stopLoss:'2601'}},context,now).evaluation.rejectCode).toBe('RISK_PROTECTION_STOP_WIDENING')
    expect(evaluatePositionProtection({...request,protection:{takeProfit:'2500.10'}},context,now).evaluation.rejectCode).toBe('RISK_TAKE_PROFIT_DIRECTION_INVALID')
  })
  it('allows explicit first stop or TP-only change without inventing the other price', () => {
    const f=fixture(), context={...f.context,position:{...f.context.position,stopLoss:null}}
    expect(evaluatePositionProtection({...f.request,protection:{stopLoss:'2450'}},context,now).evaluation.status).toBe('approved')
    expect(evaluatePositionProtection({...f.request,protection:{takeProfit:'2600'}},f.context,now).evaluation.approvedActions[0]!.parameters).toEqual({ticket:'101',take_profit:'2600'})
  })
  it('keeps large adjacent prices distinct and uses exact spread and tick comparisons', () => {
    const f=fixture(), request={...f.request,protection:{stopLoss:'9007199254740992.00'}}, context={...f.context,
      position:{...f.context.position,stopLoss:'9007199254740992.01'},quote:{...f.context.quote,bid:'9007199254740993',ask:'9007199254740993.10'}}
    expect(evaluatePositionProtection(request,context,now).evaluation.rejectCode).toBe('RISK_PROTECTION_STOP_WIDENING')
    expect(evaluatePositionProtection({...request,protection:{stopLoss:'9007199254740992.02'}},context,now).evaluation.status).toBe('approved')
    f.context.quote.ask='2501.200000000000000001'
    expect(evaluate(f).evaluation.rejectCode).toBe('RISK_SPREAD_LIMIT')
    f.context.quote.ask='2501.2'
    expect(evaluate(f).evaluation.status).toBe('approved')
  })
  it.each([{stopLoss:'0'},{stopLoss:'1e3'},{stopLoss:'01'},{stopLoss:'1.0000000000000000001'},{removeStopLoss:true},{}])('rejects malformed protection input %j', protection => {
    const f=fixture()
    expect(()=>evaluatePositionProtection({...f.request,protection} as PositionProtectionRiskRequest,f.context,now)).toThrow('position_protection_request_invalid')
  })
  it('rejects disabled instruments, disallowed symbols and quote-symbol mismatch', () => {
    const f=fixture()
    expect(evaluatePositionProtection(f.request,{...f.context,instrument:{...f.context.instrument,tradeEnabled:false}},now).evaluation.rejectCode).toBe('RISK_INSTRUMENT_TRADE_DISABLED')
    f.context.policy.values.allowedSymbols=['EURUSD']
    expect(evaluate(f).evaluation.rejectCode).toBe('RISK_SYMBOL_NOT_ALLOWED')
    f.context.quote.symbol='EURUSD'
    expect(evaluate(f).evaluation.rejectCode).toBe('RISK_PROTECTION_SYMBOL_MISMATCH')
  })
  it('reads the trusted clock after current context and never borrows an old decision approval', async () => {
    const f=fixture(), trace:string[]=[], read=vi.fn(async()=>{trace.push('context');return f.context}),
      clock={now:vi.fn(async()=>{trace.push('clock');return new Date(f.request.expiresAt)})}
    const reviewer=createPositionProtectionReviewer({read},clock)
    expect((await reviewer.review(f.request)).evaluation.rejectCode).toBe('RISK_PROTECTION_REQUEST_EXPIRED')
    expect(trace).toEqual(['context','clock'])
    await expect(createPositionProtectionReviewer({read:async()=>null},clock).review(f.request)).rejects.toThrow('position_protection_context_unavailable')
  })
})


it('rechecks account and instrument age at final review time, not just at SQL read time',()=>{
  const f=fixture();Object.assign(f.context,{accountObservedAt:new Date(now.getTime()-31000).toISOString()})
  expect(evaluate(f).evaluation.rejectCode).toBe('RISK_ACCOUNT_STALE')
  Object.assign(f.context,{accountObservedAt:now.toISOString()});Object.assign(f.context.instrument,{observedAt:new Date(now.getTime()-300001).toISOString()})
  expect(evaluate(f).evaluation.rejectCode).toBe('RISK_INSTRUMENT_STALE')
  Object.assign(f.context.instrument,{observedAt:now.toISOString(),maxAgeMs:300001})
  expect(evaluate(f).evaluation.rejectCode).toBe('RISK_INSTRUMENT_STALE')
})
