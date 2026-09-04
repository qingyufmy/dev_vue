import type { OutboxTaskPublisher, ClaimedOutboxEvent } from '../application/outbox-ports.js'
import type { RuntimeTaskQueues } from '../../queue/task-queues.js'

export class BullMqOutboxTaskPublisher implements OutboxTaskPublisher {
  constructor(private readonly queues: RuntimeTaskQueues) {}

  async publish(event: ClaimedOutboxEvent) {
    if (event.eventType === 'analysis.requested') {
      const analysisId = requiredId(event.payload.analysis_id, 'outbox_analysis_id_invalid')
      await this.queues.analysis.add('analysis.run', { analysisId }, { jobId: event.eventId })
      return
    }
    if (event.eventType === 'trader.requested') {
      const traderRunId = requiredId(event.payload.trader_run_id, 'outbox_trader_run_id_invalid')
      await this.queues.trader.add('trader.run', { traderRunId }, { jobId: event.eventId })
      return
    }
    if (event.eventType === 'trade_decision.created') {
      if (event.payload.status !== 'proposed') return
      const decisionId = requiredId(event.payload.decision_id, 'outbox_decision_id_invalid')
      await this.queues.risk.add('risk.review', { decisionId }, { jobId: event.eventId })
      return
    }
    if (event.eventType === 'risk.decision.created') {
      if (event.payload.status !== 'approved') return
      const riskDecisionId = requiredId(event.payload.risk_decision_id, 'outbox_risk_decision_id_invalid')
      const userId = requiredUserId(event.payload.user_id)
      await this.queues.execution.add('execution.risk-decision.prepare', { riskDecisionId, userId }, { jobId: event.eventId })
      return
    }
    if (event.eventType === 'execution.intent.prepared') {
      const intentId = requiredId(event.payload.intent_id, 'outbox_intent_id_invalid')
      await this.queues.execution.add('execution.intent.prepare', { intentId }, { jobId: event.eventId })
      return
    }
    if (event.eventType === 'bridge.command.queued') {
      const commandId = requiredId(event.payload.command_id, 'outbox_command_id_invalid')
      await this.queues.bridgeDispatch.add('bridge.command.dispatch', { commandId }, { jobId: event.eventId })
    }
  }
}

function requiredUserId(value: unknown) {
  const userId = Number(value)
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('outbox_user_id_invalid')
  return userId
}

function requiredId(value: unknown, code: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/.test(value)) throw new Error(code)
  return value
}
