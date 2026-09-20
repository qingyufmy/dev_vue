import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeCommand } from '../src/modules/execution/index.js'
import { wakePositionProtectionResult } from '../src/modules/execution/infrastructure/mysql-position-protection-result-wakeup.js'

const command = { id: 'command-id', executionIntentId: 'child-id', userId: 7, accountId: '5', action: 'position.protection.set' } as BridgeCommand
function fixture(status = 'protecting', revision = 3, exists = true) {
  const execute = vi.fn().mockResolvedValueOnce([exists ? [{ id: 'workflow-id', user_id: 7, account_id: '5', status, revision }] : []]).mockResolvedValue([{}])
  return { execute, db: { execute } as unknown as PoolConnection }
}
it('emits a workflow-only wakeup using the result transaction connection', async () => {
  const { execute, db } = fixture()
  await wakePositionProtectionResult(db, command, 'workflow-id')
  expect(execute.mock.calls[0]![1]).toEqual(['command-id', 'child-id', 'workflow-id', 7, '5'])
  expect(execute.mock.calls[1]![0]).toContain('execution.partial-close.requested')
  expect(JSON.parse(execute.mock.calls[1]![1][2])).toEqual({ workflow_id: 'workflow-id', user_id: 7, trading_account_id: '5' })
})
it.each(['succeeded', 'stopped'])('does not reopen %s workflows', async status => {
  const { execute, db } = fixture(status, 4)
  await wakePositionProtectionResult(db, command, 'workflow-id')
  expect(execute).toHaveBeenCalledTimes(1)
})
it('rejects a missing or foreign command binding before emitting an event', async () => {
  const { execute, db } = fixture('protecting', 3, false)
  await expect(wakePositionProtectionResult(db, command, 'workflow-id')).rejects.toMatchObject({ code: 'position_protection_result_scope_invalid' })
  expect(execute).toHaveBeenCalledTimes(1)
})
it('rejects an inconsistent workflow revision', async () => {
  const { execute, db } = fixture('protecting', 4)
  await expect(wakePositionProtectionResult(db, command, 'workflow-id')).rejects.toMatchObject({ code: 'position_protection_result_workflow_invalid' })
  expect(execute).toHaveBeenCalledTimes(1)
})
it('propagates outbox failure so the enclosing result transaction cannot acknowledge success', async () => {
  const { execute, db } = fixture()
  execute.mockRejectedValueOnce(Error('sql_failed'))
  await expect(wakePositionProtectionResult(db, command, 'workflow-id')).rejects.toThrow('sql_failed')
})
