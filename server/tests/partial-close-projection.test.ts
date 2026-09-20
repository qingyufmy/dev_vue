import { describe, expect, it, vi } from 'vitest'
import type { ExecutionPositionCollection } from '../src/modules/trading/index.js'
import { createPartialCloseProjectionReader, createPartialCloseProgressCapture } from '../src/bootstrap/partial-close-progress.js'
import { evaluatePartialCloseProtection } from '../src/modules/execution/domain/partial-close-protection.js'
import type { PoolConnection } from 'mysql2/promise'

const route = { userId:7,accountId:'5',terminalProfileId:'profile',terminalInstanceId:'terminal',platform:'mt5' as const,
  brokerServer:'Broker',login:'42',connectionEpoch:1,connectionId:'connection',installationId:'installation',credentialGeneration:1,ownershipRevision:'1',timezoneOffsetMinutes:180,sessionId:'session' }
const target = {userId:'7',accountId:'5',terminalInstanceId:'terminal',brokerServer:'Broker',login:'42',positionIdentifier:'100',ticket:'101',symbol:'XAUUSD',side:'buy' as const}
const now = Date.parse('2026-09-10T10:00:00.123Z')
const plan = {workflowId:'workflow',parentIntentId:'intent',parentCommandId:'command',target,initialVolume:'0.10',closeVolume:'0.08',initialRevision:5,expiresAt:now+1000,protection:{stopLoss:'2400'}}
const item = {accountId:'5',ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy' as const,volume:'0.02'}
function fixture(snapshot: ExecutionPositionCollection | null = {accountId:'5',revision:6,observedAt:new Date(now).toISOString(),positions:[item]}) {
  const read = vi.fn(async () => snapshot)
  return { read, reader: createPartialCloseProjectionReader({read},route,30000) }
}
const evaluate = (projection: Awaited<ReturnType<ReturnType<typeof fixture>['reader']['read']>>) => evaluatePartialCloseProtection({plan,parentState:'succeeded',
  history:{parentIntentId:'intent',parentCommandId:'command',target,closedVolume:'0.08',completedAt:now-10},projection,now,maxProjectionAgeMs:30000})
describe('current authorized collection to workflow target projection', () => {
  it('requests the latest complete collection and only grants eligibility for current risk review', async () => {
    const f=fixture(), projection=await f.reader.read(plan)
    expect(f.read).toHaveBeenCalledExactlyOnceWith({route,maxAgeMs:30000})
    expect(projection).toMatchObject({complete:true,revision:6,observedAt:now,positions:[{target,volume:'0.02'}]})
    expect(evaluate(projection).state).toBe('risk_review_required')
  })
  it('distinguishes proven absence from an unavailable or identity-incomplete collection', async () => {
    const empty=fixture({accountId:'5',revision:6,observedAt:new Date(now).toISOString(),positions:[]})
    expect(evaluate(await empty.reader.read(plan))).toEqual({state:'stopped',reason:'position_absent'})
    expect(evaluate(await fixture(null).reader.read(plan))).toEqual({state:'wait_projection'})
    const unknown=fixture({accountId:'5',revision:6,observedAt:new Date(now).toISOString(),positions:[{...item,positionIdentifier:null}]})
    expect(evaluate(await unknown.reader.read(plan))).toEqual({state:'wait_projection'})
  })
  it.each([{ticket:'102'},{positionIdentifier:'999'},{symbol:'EURUSD'},{side:'sell' as const}])('retains changed identity for deterministic rejection %j', patch => {
    const f=fixture({accountId:'5',revision:6,observedAt:new Date(now).toISOString(),positions:[{...item,...patch}]})
    return f.reader.read(plan).then(projection=>expect(evaluate(projection)).toEqual({state:'stopped',reason:'position_identity_mismatch'}))
  })
  it('never substitutes another position with the same symbol and quantity', async () => {
    const f=fixture({accountId:'5',revision:6,observedAt:new Date(now).toISOString(),positions:[{...item,ticket:'102',positionIdentifier:'200'}]})
    expect(evaluate(await f.reader.read(plan))).toEqual({state:'stopped',reason:'position_absent'})
  })
  it('retains revision and observation time so the eligibility check rejects old facts', async () => {
    const f=fixture({accountId:'5',revision:5,observedAt:new Date(now).toISOString(),positions:[item]})
    expect(evaluate(await f.reader.read(plan))).toEqual({state:'wait_projection'})
  })
  it('rejects wrong scope before collection access and propagates storage failures', async () => {
    const f=fixture()
    await expect(f.reader.read({...plan,target:{...target,login:'43'}})).resolves.toBeNull()
    expect(f.read).not.toHaveBeenCalled()
    f.read.mockRejectedValueOnce(Error('database_down'))
    await expect(f.reader.read(plan)).rejects.toThrow('database_down')
  })
  it('captures a missing route before SQL and keeps it unavailable even when the lease later appears', async () => {
    const current=vi.fn(async()=>null)
    const bind=await createPartialCloseProgressCapture({current},30000)({workflowId:'workflow',userId:7,accountId:'5'})
    const facts=bind({} as PoolConnection)
    await expect(facts.history.read(plan)).resolves.toBeNull()
    await expect(facts.projection.read(plan)).resolves.toBeNull()
    expect(current).toHaveBeenCalledExactlyOnceWith('5')
  })
  it('defers Redis failures to fact access so durable workflow replay can proceed', async () => {
    const failure = Error('redis_unavailable')
    const bind = await createPartialCloseProgressCapture({ current: async () => { throw failure } },30000)({workflowId:'workflow',userId:7,accountId:'5'})
    const facts = bind({} as PoolConnection)
    await expect(facts.history.read(plan)).rejects.toBe(failure)
    await expect(facts.projection.read(plan)).rejects.toBe(failure)
  })
})
