import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeCommand } from '../src/modules/execution/index.js'
import { wakePartialCloseResult } from '../src/modules/execution/infrastructure/mysql-partial-close-result-wakeup.js'

const command = { id: 'parent-command', executionIntentId: 'parent-intent', userId: 7, accountId: '5', action: 'position.close' } as BridgeCommand
function fixture(status = 'awaiting_close', overrides = {}) {
  const execute = vi.fn().mockResolvedValueOnce([[{ id: 'workflow', parent_intent_id: 'parent-intent', user_id: 7, account_id: '5', status, ...overrides }]]).mockResolvedValue([{}])
  return { execute, db: { execute } as unknown as PoolConnection }
}
it.each(['awaiting_close', 'risk_review_required', 'protecting'])('wakes %s without updating business state', async status => {
  const { execute, db } = fixture(status)
  await wakePartialCloseResult(db, command)
  expect(execute).toHaveBeenCalledTimes(2)
  expect(execute.mock.calls[0]![1]).toEqual([command.id])
  expect(execute.mock.calls[1]![0]).toContain('INSERT INTO outbox_events')
  expect(JSON.parse(execute.mock.calls[1]![1][2])).toEqual({ workflow_id: 'workflow', user_id: 7, trading_account_id: '5' })
})
it.each(['succeeded', 'stopped', 'expired'])('does not reopen %s', async status => {
  const { execute, db } = fixture(status)
  await wakePartialCloseResult(db, command)
  expect(execute).toHaveBeenCalledTimes(1)
})
it.each([{ user_id: 8 }, { account_id: '6' }, { parent_intent_id: 'other' }])('rejects mismatched ownership or intent %j', async overrides => {
  const { execute, db } = fixture('awaiting_close', overrides)
  await expect(wakePartialCloseResult(db, command)).rejects.toMatchObject({ code: 'partial_close_result_scope_invalid' })
  expect(execute).toHaveBeenCalledTimes(1)
})
it('leaves non-close commands and closes without a continuation alone', async () => {
  const execute = vi.fn().mockResolvedValue([[]]), db = { execute } as unknown as PoolConnection
  await wakePartialCloseResult(db, { ...command, action: 'position.protection.set' })
  expect(execute).not.toHaveBeenCalled()
  await wakePartialCloseResult(db, command)
  expect(execute).toHaveBeenCalledTimes(1)
})
it('propagates wakeup insert failure to the result transaction', async () => {
  const { execute, db } = fixture()
  execute.mockRejectedValueOnce(Error('wakeup_insert_failed'))
  await expect(wakePartialCloseResult(db, command)).rejects.toThrow('wakeup_insert_failed')
})
