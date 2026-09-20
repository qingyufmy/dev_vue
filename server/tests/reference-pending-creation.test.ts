import { expect, it, vi } from 'vitest'
import type { StrategyObserverInventory } from '../src/modules/trading/index.js'
import { readReferencePendingCreation, type ReferencePendingCreationReader } from '../src/modules/inference/application/reference-pending-creation.js'

const inventory = () => ({ authorization: { userId: 7, operatorUserId: 8 },
  route: { accountId: '9', terminalInstanceId: 'terminal', brokerServer: 'Broker', login: '001', connectionEpoch: 4 },
  pendingOrders: { revision: 6, items: [{ ticket: '91' }, { ticket: '92' }] } }) as StrategyObserverInventory
const origin = { ticket: '91', status: 'strategy' as const, userId: 8, accountId: '9', strategyId: '20' }
const unresolved = { ticket: '92', status: 'unresolved' as const }

it('binds historical creation lookup to the source operator and route, retaining unresolved tickets', async () => {
  const rows = [unresolved, origin], read = vi.fn().mockResolvedValue(rows)
  const input = inventory(), pending = readReferencePendingCreation(input, { read })
  input.route.accountId = 'other'
  const result = await pending
  expect(read).toHaveBeenCalledWith({ userId: 8, accountId: '9', terminalInstanceId: 'terminal', brokerServer: 'Broker',
    login: '001', connectionEpoch: '4', tickets: ['91', '92'] })
  expect(result).toEqual([origin, unresolved])
  rows[1] = { ...origin, strategyId: '99' }
  expect(result[0]).toMatchObject({ strategyId: '20' })
})

it.each([
  [origin], [origin, origin], [origin, { ...unresolved, ticket: '93' }],
  [{ ...origin, userId: 7 }, unresolved], [{ ...origin, accountId: '10' }, unresolved],
  [{ ...origin, strategyId: '18446744073709551616' }, unresolved],
  [{ ...origin, status: 'manual' }, unresolved],
].map(rows => ({ rows })))('rejects incomplete, duplicate or mismatched creation evidence: %j', async ({ rows }) => {
  await expect(readReferencePendingCreation(inventory(), { read: async () => rows } as unknown as ReferencePendingCreationReader))
    .rejects.toThrow('strategy_reference_pending_creation_invalid')
})

it('distinguishes proven empty inventory from failed reads', async () => {
  const empty = inventory(); empty.pendingOrders.items = []
  expect(await readReferencePendingCreation(empty, { read: async () => [] })).toEqual([])
  await expect(readReferencePendingCreation(inventory(), { read: async () => { throw Error('read_failed') } })).rejects.toThrow('read_failed')
})

it('rejects malformed inventory tickets before reading origins', async () => {
  const read = vi.fn()
  for (const tickets of [['91', '91'], ['0'], ['18446744073709551616']]) {
    const input = inventory(); input.pendingOrders.items = tickets.map(ticket => ({ ticket })) as typeof input.pendingOrders.items
    await expect(readReferencePendingCreation(input, { read })).rejects.toThrow('strategy_reference_pending_creation_invalid')
  }
  expect(read).not.toHaveBeenCalled()
})

it('retains exact decision identifiers and historical strategy version without aliasing provider values',async()=>{
  const decisionOrigin={decisionId:'decision-1',riskDecisionId:'risk-1',strategyVersionId:'31'}
  const result=await readReferencePendingCreation(inventory(),{read:async()=>[{...origin,decisionOrigin},unresolved]})
  decisionOrigin.strategyVersionId='99'
  expect(result[0]).toMatchObject({decisionOrigin:{decisionId:'decision-1',riskDecisionId:'risk-1',strategyVersionId:'31'}})
})
it.each([{decisionId:'',riskDecisionId:'risk-1',strategyVersionId:'31'},
  {decisionId:'decision-1',riskDecisionId:'bad\n',strategyVersionId:'31'},
  {decisionId:'decision-1',riskDecisionId:'risk-1',strategyVersionId:'0'}])('rejects malformed creation decision metadata',async decisionOrigin=>{
  await expect(readReferencePendingCreation(inventory(),{read:async()=>[{...origin,decisionOrigin},unresolved]}))
    .rejects.toThrow('strategy_reference_pending_creation_invalid')
})
