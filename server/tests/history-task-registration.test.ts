import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { registerHistoryCollectionTask } from '../src/modules/trade-history/infrastructure/mysql-history-task-registration.js'

const request = { taskId: '00000000-0000-4000-8000-000000000001', accountId: '5', rangeStartUtcMsc: 1000, rangeEndUtcMsc: 2000 }
function fixture() {
  const trace: string[] = [], state = { same: false, active: null as string | null, event: true, timezone: '+00:00', end: '2000' }
  const accounts = { lockAccount: vi.fn(async () => { trace.push('account-lock') }) }
  const execute = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.startsWith('SELECT @@session')) return [[{ timezone: state.timezone }]]
    if (sql.startsWith('SELECT id,CAST')) return [state.same ? [{ id: request.taskId, start_msc: '1000', end_msc: state.end }] : []]
    if (sql.startsWith('SELECT id FROM history_collection')) return [state.active ? [{ id: state.active }] : []]
    if (sql.startsWith('SELECT aggregate_type')) return [state.event ? [{ aggregate_type: 'trade_history_task', aggregate_id: values[0], event_type: 'trade.history.task.requested', payload_json: { task_id: values[0] } }] : []]
    trace.push(sql.includes('outbox_events') ? 'outbox' : 'task')
    return [{ affectedRows: 1 }]
  })
  return { state, accounts, trace, execute, connection: { execute } as unknown as PoolConnection }
}
it('creates task then outbox under the caller account lock with an ID-only payload', async () => {
  const f = fixture()
  expect(await registerHistoryCollectionTask(f.connection, f.accounts, request, new Date(3000))).toEqual({ taskId: request.taskId, created: true })
  expect(f.trace).toEqual(['account-lock', 'task', 'outbox'])
  const [, params] = f.execute.mock.calls.at(-1)!
  expect(params.slice(0, 3)).toEqual([request.taskId, request.taskId, JSON.stringify({ task_id: request.taskId })])
})
it('reuses a prior task without emitting another event', async () => {
  const f = fixture(); f.state.same = true
  expect(await registerHistoryCollectionTask(f.connection, f.accounts, request, new Date(3000))).toEqual({ taskId: request.taskId, created: false })
  expect(f.trace).toEqual(['account-lock'])
})
it('retains an existing active batch rather than extending its window', async () => {
  const f = fixture(); f.state.active = '00000000-0000-4000-8000-000000000002'
  expect(await registerHistoryCollectionTask(f.connection, f.accounts, request, new Date(3000))).toEqual({ taskId: f.state.active, created: false })
  expect(f.trace).toEqual(['account-lock'])
})
it('rejects changed windows for the same task ID', async () => {
  const f = fixture(); f.state.same = true; f.state.end = '2001'
  await expect(registerHistoryCollectionTask(f.connection, f.accounts, request, new Date(3000))).rejects.toThrow('history_task_registration_conflict')
  expect(f.trace).toEqual(['account-lock'])
})
it('does not report a task without its durable event as successfully registered', async () => {
  const f = fixture(); f.state.same = true; f.state.event = false
  await expect(registerHistoryCollectionTask(f.connection, f.accounts, request, new Date(3000))).rejects.toThrow('history_task_registration_incomplete')
})
it('rejects a future window before acquiring locks', async () => {
  const f = fixture()
  await expect(registerHistoryCollectionTask(f.connection, f.accounts, request, new Date(1999))).rejects.toThrow('history_task_request_invalid')
  expect(f.accounts.lockAccount).not.toHaveBeenCalled()
})
it('rejects non-UTC session before task or outbox writes', async () => {
  const f = fixture(); f.state.timezone = '+08:00'
  await expect(registerHistoryCollectionTask(f.connection, f.accounts, request, new Date(3000))).rejects.toThrow('history_task_session_invalid')
  expect(f.trace).toEqual(['account-lock'])
})
