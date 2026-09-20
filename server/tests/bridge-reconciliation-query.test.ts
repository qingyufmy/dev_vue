import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlBridgeCommandRepository } from '../src/modules/execution/infrastructure/mysql-bridge-command-repository.js'

const route = { terminalInstanceId: 'terminal-1', brokerServer: 'Broker-Demo', login: '123', connectionEpoch: 9 }
const row = { id: 'command-1', execution_intent_id: 'intent-1', user_id: 7, trading_account_id: '42',
  command_sequence: 1, terminal_instance_id: route.terminalInstanceId, broker_server: route.brokerServer,
  account_login: route.login, connection_epoch: 8, status: 'uncertain', action: 'order.place', revision: 3,
  issued_at_utc: new Date('2026-09-09T00:00:00.000Z'), deadline_at_utc: new Date('2026-09-09T00:01:00.000Z'),
  created_at_utc: new Date('2026-09-09T00:00:00.000Z'), updated_at_utc: new Date('2026-09-09T00:01:00.000Z'),
  request_envelope_json: '{"payload":{"params":{"order_type":"buy_limit"}}}', result_json: JSON.stringify({ order_ticket: '9007199254740993' }) }
function fixture() {
  // Model SQL projection, so a JOIN without the selected result field reproduces the original defect.
  const execute = vi.fn(async (sql: string) => [[{ ...row, result_json: sql.split('FROM')[0]!.includes('r.result_json') ? row.result_json : undefined }], []])
  const unavailable = (): never => { throw new Error('unexpected dependency') }
  return { execute, repository: new MysqlBridgeCommandRepository({ execute } as unknown as Pool, unavailable, unavailable) }
}
it('returns the matching persisted result ticket as a reconciliation hint without numeric precision loss', async () => {
  const { repository, execute } = fixture()
  const candidates = await repository.listReconciliationCandidates('42', route, 10)
  expect(candidates[0]?.terminalTicket).toBe('9007199254740993')
  expect(candidates[0]?.command.id).toBe('command-1')
  const sql = execute.mock.calls[0]![0]
  expect(sql).toContain('r2.result_sha256=c.result_sha256')
  expect(sql).not.toContain('c.*')
})
it('bounds the recovery query before reading storage', async () => {
  const { repository, execute } = fixture()
  await expect(repository.listReconciliationCandidates('42', route, 101)).rejects.toMatchObject({ code: 'bridge_command_reconcile_limit_invalid' })
  expect(execute).not.toHaveBeenCalled()
})
