import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { AccountClockReader } from '../../trading/index.js'
import type { HistoryTaskProcessor } from './history-task-processor.js'

export interface HistoryTaskLocator {
  find(taskId: string): Promise<{ accountId: string; status: 'pending' | 'running' | 'completing' | 'succeeded' | 'failed' } | null>
}

export class HistoryTaskWorker {
  constructor(private readonly tasks: HistoryTaskLocator,
    private readonly routes: { current(accountId: string): Promise<BridgeGatewayRoute | null> },
    private readonly processor: Pick<HistoryTaskProcessor, 'process'>,
    private readonly clocks?: AccountClockReader) {}

  async run(taskId: string) {
    if (typeof taskId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw Error('history_task_id_invalid')
    const task = await this.tasks.find(taskId)
    if (!task) throw Error('history_task_not_found')
    // Terminal states are immutable; acknowledging them needs no live terminal connection.
    if (task.status === 'succeeded' || task.status === 'failed') return { state: 'terminal' as const, status: task.status }
    const route = await this.routes.current(task.accountId)
    if (!route) throw Error('bridge_query_route_unavailable')
    if (route.accountId !== task.accountId) throw Error('history_task_claim_mismatch')
    // The connection lease freezes login-time metadata; calibration may arrive after login.
    const clock = this.clocks ? await this.clocks.read(route.userId, route.accountId) : null
    if (this.clocks && (!clock || clock.clockStatus !== 'calibrated' || clock.timezoneOffsetMinutes === null)) {
      throw Error('history_task_clock_unavailable')
    }
    return this.processor.process(taskId, clock ? { ...route, timezoneOffsetMinutes: clock.timezoneOffsetMinutes } : route)
  }
}
