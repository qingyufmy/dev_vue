import {describe,it,expect,vi} from 'vitest'
import type {BridgeGatewayRoute} from '../src/modules/bridge/index.js'
import {createPositionProtectionContextReader} from '../src/bootstrap/position-protection-review.js'
import {createPartialCloseDispatchContextReader} from '../src/bootstrap/partial-close-dispatch-review.js'
import {createPartialCloseDispatchReviewer} from '../src/modules/risk/index.js'
import {DEFAULT_RISK_POLICY,resolveRiskPolicy,evaluatePositionProtection} from '../src/modules/risk/index.js'
const observedAt='2026-09-10T10:00:00.123Z',now=Date.parse(observedAt)
const route={userId:7,accountId:'5',terminalProfileId:'profile',terminalInstanceId:'terminal',platform:'mt5',brokerServer:'Broker',login:'42',connectionEpoch:1,connectionId:'connection',ownershipRevision:'1'} as BridgeGatewayRoute
const target={terminalInstanceId:'terminal',brokerServer:'Broker',login:'42',ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy' as const}
const request={workflowId:'00000000-0000-8000-8000-000000000001',workflowRevision:2,userId:7,accountId:'5',target,remainingVolume:'0.02',minimumPositionRevision:6,notBefore:now-1000,expiresAt:now+30000,protection:{stopLoss:'2450'}}
function fixture(){
  const policy=resolveRiskPolicy({userId:7,accountId:'5',platformPolicyVersionId:'1',accountPolicyVersionId:null,policySetRevision:1,platform:{values:{...DEFAULT_RISK_POLICY},globalKillSwitch:false,revision:1},account:{tradeSendEnabled:true},updatedAt:observedAt})
  const summary={accountId:'5',userId:7,businessDate:'2026-09-10',equity:'10000',freeMargin:'9000',marginLevelPercent:1000,dailyLossPercent:1,drawdownPercent:1,openPositions:1,pendingOrders:0,totalVolume:'0.02',dailyOpenCount:1,consecutiveLosses:0,terminalTimezoneOffsetMinutes:180,clockStatus:'calibrated' as const,lastSuccessfulOpenAt:null,cooldownUntil:null,dataComplete:true,incompleteReasons:[],observedAt,revision:4}
  const data={accounts:{accountId:'5',account:{revision:2,observedAt,tradePermission:true,timezoneOffsetMinutes:180,clockStatus:'calibrated' as const}},
    positions:{accountId:'5',revision:6,observedAt,positions:[{accountId:'5',...target,volume:'0.02',stopLoss:'2400',takeProfit:null}]},
    quotes:{accountId:'5',symbol:'XAUUSD',bid:'2500',ask:'2500.1',revision:8,observedAt},
    instruments:{accountId:'5',symbol:'XAUUSD',point:'0.01',tickSize:'0.01',tradeEnabled:true,revision:3,observedAt},summaries:summary}
  const facts={accounts:{read:vi.fn(async()=>data.accounts)},positions:{read:vi.fn(async()=>data.positions)},quotes:{read:vi.fn(async()=>data.quotes)},instruments:{read:vi.fn(async()=>data.instruments)},summaries:{read:vi.fn(async()=>data.summaries)},policies:{getEffectivePolicy:vi.fn(async()=>policy)}}
  return {data,facts,reader:createPositionProtectionContextReader(facts,route,{maxAgeMs:30000,maxInstrumentAgeMs:300000})}
}
describe('protection context composition',()=>{
  it('requires explicit volume constraints for parent close admission without breaking price-only protection',async()=>{
    const f=fixture(),parent=createPartialCloseDispatchContextReader(f.reader)
    const input={workflowId:request.workflowId,userId:7,accountId:'5',target,initialVolume:'0.02',closeVolume:'0.01',positionRevision:6,notBefore:now-1000,expiresAt:now+30000}
    expect(await f.reader.read(request)).not.toBeNull()
    expect(await parent.read(input)).toBeNull()
    Object.assign(f.data.instruments,{volumeMin:'0.01',volumeMax:'10',volumeStep:'0.01'})
    const review=createPartialCloseDispatchReviewer(parent,{async now(){return new Date(now)}})
    expect(await review.review(input)).toMatchObject({status:'approved',volume:'0.01',remainingVolume:'0.01'})
    Object.assign(f.data.instruments,{volumeStep:'0.02'})
    expect(await review.review(input)).toMatchObject({status:'rejected',rejectCode:'RISK_PARTIAL_CLOSE_LIMITS_INVALID'})
  })
  it('does not turn a missing parent context into an approval',async()=>{
    const review=createPartialCloseDispatchReviewer({async read(){return null}},{async now(){throw Error('unexpected_clock')}})
    await expect(review.review({workflowId:request.workflowId,userId:7,accountId:'5',target,initialVolume:'0.02',closeVolume:'0.01',positionRevision:6,notBefore:now-1000,expiresAt:now+30000}))
      .rejects.toMatchObject({code:'partial_close_dispatch_context_unavailable'})
  })
  it('assembles every current revision and feeds dedicated deterministic review',async()=>{
    const f=fixture(),context=await f.reader.read(request);expect(context).not.toBeNull()
    expect(context!.revisions).toEqual({account:2,positions:6,quote:8,contract:3,risk:4})
    expect(evaluatePositionProtection(request,context!,new Date(now)).evaluation.status).toBe('approved')
  })
  it('refuses another user/route before any facts are read',async()=>{
    const f=fixture();await expect(f.reader.read({...request,userId:8})).resolves.toBeNull();expect(f.facts.accounts.read).not.toHaveBeenCalled()
  })
  it('does not substitute same-symbol positions or ambiguous stable identities',async()=>{
    const f=fixture();f.data.positions.positions[0]!.ticket='102';f.data.positions.positions[0]!.positionIdentifier='103'
    await expect(f.reader.read(request)).resolves.toBeNull()
    f.data.positions.positions=[{...f.data.positions.positions[0]!,ticket:'101'},{...f.data.positions.positions[0]!,positionIdentifier:'100'}]
    await expect(f.reader.read(request)).resolves.toBeNull()
  })
  it('keeps changed target facts for explicit deterministic rejection',async()=>{
    const f=fixture();f.data.positions.positions[0]!.positionIdentifier='999'
    const context=await f.reader.read(request);expect(context).not.toBeNull()
    expect(evaluatePositionProtection(request,context!,new Date(now)).evaluation.rejectCode).toBe('RISK_PROTECTION_TARGET_MISMATCH')
  })
  it('rejects account-summary clock disagreement and preserves permission denial',async()=>{
    const f=fixture();f.data.summaries.terminalTimezoneOffsetMinutes=120;await expect(f.reader.read(request)).resolves.toBeNull()
    f.data.summaries.terminalTimezoneOffsetMinutes=180;f.data.accounts.account.tradePermission=false
    const context=await f.reader.read(request);expect(evaluatePositionProtection(request,context!,new Date(now)).evaluation.rejectCode).toBe('RISK_PROTECTION_ACCESS_UNAVAILABLE')
  })
  it('requires explicit protection facts and propagates SQL errors',async()=>{
    const f=fixture();Reflect.deleteProperty(f.data.positions.positions[0]!,'stopLoss');await expect(f.reader.read(request)).resolves.toBeNull()
    f.facts.accounts.read.mockRejectedValueOnce(Error('db_down'));await expect(f.reader.read(request)).rejects.toThrow('db_down')
  })
})
