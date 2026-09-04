import type { TradeHistoryScheduleRepository } from './trade-history-collector-ports.js'

export class TradeHistoryScheduleService {
  constructor(private readonly repository: TradeHistoryScheduleRepository) {}
  schedule(limit: number, now = new Date()) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('trade_history_schedule_limit_invalid')
    return this.repository.scheduleDue(limit, now)
  }
}
