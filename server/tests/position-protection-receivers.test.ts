import { expect, it, vi } from 'vitest'
import { createPositionProtectionReceivers } from '../src/modules/execution/application/position-protection-receivers.js'
import { createPositionProtectionPreparationReceiver } from '../src/modules/execution/application/position-protection-preparation-receiver.js'
import { bridgeCommandId, type BridgeCommand, type CreateBridgeCommandInput } from '../src/modules/execution/domain/bridge-command.js'
const scope = { workflowId: '11111111-1111-4111-a111-111111111111', userId: 7, accountId: '5' }
const childId = '22222222-2222-5222-a222-222222222222'
function fixture() {
  const command = { id: bridgeCommandId(childId, 1), executionIntentId: childId, commandSequence: 1, userId: 7, accountId: '5', action: 'position.protection.set', status: 'queued' } as BridgeCommand
  const input = { executionIntentId: childId, commandSequence: 1, userId: 7, accountId: '5', action: 'position.protection.set' } as CreateBridgeCommandInput
  const read = vi.fn(async (): Promise<'active' | 'terminal'> => 'active')
  const source = { loadPrepared: vi.fn(async () => ({ intentId: childId, accountId: '5', command: input })) }
  const leases = { acquire: vi.fn(async () => true), renew: vi.fn(async () => true), release: vi.fn(async () => {}) }
  const commands = { findByIntent: vi.fn(async (): Promise<BridgeCommand | null> => command), create: vi.fn(async () => command),
    dispatch: vi.fn(async () => command), reconcile: vi.fn(async () => command) }
  const transport = { currentRoute: vi.fn(async () => null), send: vi.fn(async () => {}) }
  return { command, read, source, leases, commands, transport,
    prepareOnly: createPositionProtectionPreparationReceiver({ scope: { read }, source, leases, commands }),
    receivers: createPositionProtectionReceivers({ scope: { read }, source, leases, commands, transport }) }
}
it('worker preparation persists a command without dispatch or reconciliation capability', async () => {
  const f = fixture(); f.commands.findByIntent.mockResolvedValue(null)
  await f.prepareOnly(scope, childId)
  expect(f.commands.create).toHaveBeenCalledOnce()
  expect(f.leases.renew).toHaveBeenCalledOnce()
  expect(f.commands.dispatch).not.toHaveBeenCalled()
  expect(f.commands.reconcile).not.toHaveBeenCalled()
  expect(f.transport.send).not.toHaveBeenCalled()
})
it.each(['queued', 'dispatched', 'uncertain', 'succeeded'] as const)('worker preparation reuses durable %s commands without terminal I/O', async status => {
  const f = fixture(); f.command.status = status
  await f.prepareOnly(scope, childId)
  expect(f.commands.create).not.toHaveBeenCalled()
  expect(f.source.loadPrepared).not.toHaveBeenCalled()
  expect(f.commands.dispatch).not.toHaveBeenCalled()
  expect(f.commands.reconcile).not.toHaveBeenCalled()
})
it('worker preparation recovers a committed command after acknowledgement loss without recreating it', async () => {
  const f = fixture(), unknown = Error('bridge_command_commit_unknown')
  f.commands.findByIntent.mockResolvedValueOnce(null)
  f.commands.create.mockRejectedValueOnce(unknown)
  await expect(f.prepareOnly(scope, childId)).rejects.toBe(unknown)
  await f.prepareOnly(scope, childId)
  expect(f.commands.create).toHaveBeenCalledOnce()
  expect(f.leases.release).toHaveBeenCalledTimes(2)
  expect(f.commands.dispatch).not.toHaveBeenCalled()
})
it('worker preparation refuses an out-of-scope candidate before persistence', async () => {
  const f = fixture(); f.commands.findByIntent.mockResolvedValue(null)
  f.source.loadPrepared.mockResolvedValue({ intentId: childId, accountId: 'other', command: {} as CreateBridgeCommandInput })
  await expect(f.prepareOnly(scope, childId)).rejects.toThrow('scope_mismatch')
  expect(f.commands.create).not.toHaveBeenCalled()
})
it('worker preparation stops when the workflow is terminal', async () => {
  const f = fixture(); f.read.mockResolvedValue('terminal')
  await f.prepareOnly(scope, childId)
  expect(f.commands.findByIntent).not.toHaveBeenCalled()
  expect(f.leases.release).toHaveBeenCalledOnce()
})
it('creates a missing scoped command only after acquiring and renewing the account lease', async () => {
  const f = fixture(); f.commands.findByIntent.mockResolvedValue(null)
  await f.receivers.prepared(scope, childId)
  expect(f.commands.create).toHaveBeenCalledTimes(1); expect(f.commands.dispatch).toHaveBeenCalledTimes(1)
  expect(f.leases.renew).toHaveBeenCalledTimes(2); expect(f.leases.release).toHaveBeenCalledTimes(1)
  expect(f.leases.acquire.mock.invocationCallOrder[0]).toBeLessThan(f.read.mock.invocationCallOrder[0]!)
})
it.each(['dispatched', 'accepted', 'uncertain', 'reconciling', 'succeeded'] as const)('never resends existing %s commands', async status => {
  const f = fixture(); f.command.status = status
  await f.receivers.prepared(scope, childId)
  expect(f.commands.dispatch).not.toHaveBeenCalled(); expect(f.source.loadPrepared).not.toHaveBeenCalled()
})
it('uses only reconciliation for uncertain commands', async () => {
  const f = fixture(); f.command.status = 'uncertain'
  await f.receivers.reconcile(scope, childId, f.command.id)
  expect(f.commands.reconcile).toHaveBeenCalledExactlyOnceWith(f.command.id, f.transport, null, expect.any(Date))
  expect(f.commands.dispatch).not.toHaveBeenCalled(); expect(f.commands.create).not.toHaveBeenCalled()
})
it('does not reconcile queued commands or another command ID', async () => {
  const f = fixture()
  await expect(f.receivers.reconcile(scope, childId, f.command.id)).rejects.toThrow('reconcile_status_invalid')
  await expect(f.receivers.reconcile(scope, childId, 'other')).rejects.toThrow('scope_mismatch')
  expect(f.commands.reconcile).not.toHaveBeenCalled()
})
it('stops immediately when workflow is terminal', async () => {
  const f = fixture(); f.read.mockResolvedValue('terminal')
  await f.receivers.prepared(scope, childId)
  expect(f.commands.findByIntent).not.toHaveBeenCalled(); expect(f.leases.release).toHaveBeenCalledTimes(1)
})
it('refuses dispatch after lease loss or wrong command account', async () => {
  const f = fixture(); f.leases.renew.mockResolvedValue(false)
  await expect(f.receivers.prepared(scope, childId)).rejects.toThrow('lease_lost')
  f.command.accountId = '6'
  await expect(f.receivers.prepared(scope, childId)).rejects.toThrow('scope_mismatch')
  expect(f.commands.dispatch).not.toHaveBeenCalled()
})
it('preserves commit uncertainty even when lease release also fails', async () => {
  const f = fixture(), error = new Error('bridge_command_commit_unknown')
  f.commands.dispatch.mockRejectedValue(error); f.leases.release.mockRejectedValue(new Error('redis_unavailable'))
  await expect(f.receivers.prepared(scope, childId)).rejects.toBe(error)
})
it('does not access command state when the account lease is busy', async () => {
  const f = fixture(); f.leases.acquire.mockResolvedValue(false)
  await expect(f.receivers.prepared(scope, childId)).rejects.toThrow('receiver_busy')
  expect(f.read).not.toHaveBeenCalled(); expect(f.commands.findByIntent).not.toHaveBeenCalled()
})
