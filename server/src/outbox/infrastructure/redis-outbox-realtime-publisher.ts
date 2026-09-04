import type { Redis } from 'ioredis'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { BrowserRealtimeEvent } from '../../modules/trading/application/trading-ports.js'
import { BROWSER_REALTIME_EVENT_CHANNEL } from '../../modules/trading/infrastructure/redis-browser-realtime-subscriber.js'
import type { ClaimedOutboxEvent, OutboxTaskPublisher } from '../application/outbox-ports.js'

interface AnalysisRow extends RowDataPacket {
  id: string; user_id: number; strategy_id: string; standard_symbol: string; status: string
  updated_at_utc: Date; revision: number
}
interface MarketAnalysisRow extends RowDataPacket {
  id: string; analysis_run_id: string; owner_user_id: number; strategy_id: string; standard_symbol: string
  market_bias: string; opportunity: string; confidence: string | number; valid_until_utc: Date; revision: number
  run_status: string; run_updated_at_utc: Date; run_revision: number
}
interface TraderRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; market_analysis_id: string; task_mode: string
  status: string; updated_at_utc: Date; revision: number
}
interface DecisionRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; market_analysis_id: string
  action_kind: string; side: string | null; confidence: string | number; status: string; stale_reason: string | null
  revision: number; trader_run_id: string; task_mode: string; run_status: string; run_updated_at_utc: Date; run_revision: number
}
interface RiskPolicyRow extends RowDataPacket { user_id: number; account_id: string; policy_version_id: string; revision: number }
interface RiskSummaryRow extends RowDataPacket { user_id: number; account_id: string; data_complete: number; revision: number }
interface RiskDecisionRow extends RowDataPacket {
  id: string; user_id: number; account_id: string; decision_id: string; status: string; reject_code: string | null; revision: number
}
interface RiskReleaseRow extends RowDataPacket {
  id: string; user_id: number; account_id: string; status: string; invalidation_reason: string | null; revision: number
}
interface OperationRow extends RowDataPacket {
  id: string; user_id: number; account_id: string; kind: string; status: string; updated_at_utc: Date
  resource_id: string | null; error_code: string | null; revision: number
}

const REALTIME_TYPES = new Set<ClaimedOutboxEvent['eventType']>([
  'analysis.requested', 'analysis.running', 'analysis.failed', 'market_analysis.created',
  'trader.requested', 'trader.running', 'trader.failed', 'trade_decision.created',
  'risk.policy.changed', 'risk.summary.changed', 'risk.decision.created', 'risk.manual_release.changed',
  'operation.changed',
])

export class RedisOutboxRealtimePublisher implements OutboxTaskPublisher {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly channel = BROWSER_REALTIME_EVENT_CHANNEL,
  ) {}

  async publish(event: ClaimedOutboxEvent) {
    if (!REALTIME_TYPES.has(event.eventType)) return
    for (const projected of await this.project(event)) {
      await this.redis.publish(this.channel, JSON.stringify(projected))
    }
  }

  private async project(event: ClaimedOutboxEvent): Promise<BrowserRealtimeEvent[]> {
    if (event.eventType.startsWith('analysis.')) return [await this.analysisJob(event)]
    if (event.eventType === 'market_analysis.created') return this.marketAnalysis(event)
    if (event.eventType.startsWith('trader.')) return [await this.traderJob(event)]
    if (event.eventType === 'trade_decision.created') return this.tradeDecision(event)
    if (event.eventType === 'risk.policy.changed') return [await this.riskPolicy(event)]
    if (event.eventType === 'risk.summary.changed') return [await this.riskSummary(event)]
    if (event.eventType === 'risk.decision.created') return [await this.riskDecision(event)]
    if (event.eventType === 'risk.manual_release.changed') return [await this.riskRelease(event)]
    return [await this.operation(event)]
  }

  private async analysisJob(event: ClaimedOutboxEvent) {
    const id = requiredId(event.payload.analysis_id, 'outbox_analysis_id_invalid')
    const row = await one<AnalysisRow>(this.pool,
      "SELECT r.id,r.user_id,CAST(r.strategy_id AS CHAR) strategy_id,r.standard_symbol,r.status,r.updated_at_utc,r.revision FROM ai_analysis_runs r WHERE r.id=? LIMIT 1",
      [id], 'outbox_analysis_missing')
    return base(event, {
      type: 'analysis.job.changed', userId: row.user_id, accountId: null, resource: 'analysis.job',
      resourceId: row.id, revision: row.revision,
      data: { analysis_id: row.id, strategy_id: row.strategy_id, symbol: row.standard_symbol, status: row.status, updated_at: iso(row.updated_at_utc) },
    })
  }

  private async marketAnalysis(event: ClaimedOutboxEvent) {
    const id = requiredId(event.payload.market_analysis_id, 'outbox_market_analysis_id_invalid')
    const row = await one<MarketAnalysisRow>(this.pool,
      "SELECT a.id,a.analysis_run_id,a.owner_user_id,CAST(a.strategy_id AS CHAR) strategy_id,a.standard_symbol,a.market_bias,a.opportunity,a.confidence,a.valid_until_utc,a.revision,r.status run_status,r.updated_at_utc run_updated_at_utc,r.revision run_revision FROM market_analyses a INNER JOIN ai_analysis_runs r ON r.id=a.analysis_run_id WHERE a.id=? LIMIT 1",
      [id], 'outbox_market_analysis_missing')
    return [
      base(event, {
        eventId: suffix(event.eventId, 'job'), type: 'analysis.job.changed', userId: row.owner_user_id,
        accountId: null, resource: 'analysis.job', resourceId: row.analysis_run_id, revision: row.run_revision,
        data: { analysis_id: row.analysis_run_id, strategy_id: row.strategy_id, symbol: row.standard_symbol,
          status: row.run_status, updated_at: iso(row.run_updated_at_utc) },
      }),
      base(event, {
        type: 'market_analysis.created', userId: row.owner_user_id, accountId: null, resource: 'market_analysis',
        resourceId: row.id, revision: row.revision,
        data: { analysis_id: row.id, strategy_id: row.strategy_id, symbol: row.standard_symbol,
          market_bias: row.market_bias, opportunity: row.opportunity, confidence: Number(row.confidence),
          valid_until: iso(row.valid_until_utc) },
      }),
    ]
  }

  private async traderJob(event: ClaimedOutboxEvent) {
    const id = requiredId(event.payload.trader_run_id, 'outbox_trader_run_id_invalid')
    const row = await one<TraderRow>(this.pool,
      "SELECT r.id,r.user_id,CAST(r.trading_account_id AS CHAR) trading_account_id,r.market_analysis_id,r.task_mode,r.status,r.updated_at_utc,r.revision FROM ai_trader_runs r WHERE r.id=? LIMIT 1",
      [id], 'outbox_trader_run_missing')
    return base(event, {
      type: 'trader.job.changed', userId: row.user_id, accountId: row.trading_account_id, resource: 'trader.job',
      resourceId: row.id, revision: row.revision,
      data: { trader_run_id: row.id, analysis_id: row.market_analysis_id, trading_account_id: row.trading_account_id,
        task_mode: row.task_mode, status: row.status, updated_at: iso(row.updated_at_utc) },
    })
  }

  private async tradeDecision(event: ClaimedOutboxEvent) {
    const id = requiredId(event.payload.decision_id, 'outbox_decision_id_invalid')
    const row = await one<DecisionRow>(this.pool,
      "SELECT d.id,d.user_id,CAST(d.trading_account_id AS CHAR) trading_account_id,d.market_analysis_id,d.action_kind,d.side,d.confidence,d.status,d.stale_reason,d.revision,d.trader_run_id,r.task_mode,r.status run_status,r.updated_at_utc run_updated_at_utc,r.revision run_revision FROM trade_decisions d INNER JOIN ai_trader_runs r ON r.id=d.trader_run_id WHERE d.id=? LIMIT 1",
      [id], 'outbox_trade_decision_missing')
    return [
      base(event, {
        eventId: suffix(event.eventId, 'job'), type: 'trader.job.changed', userId: row.user_id,
        accountId: row.trading_account_id, resource: 'trader.job', resourceId: row.trader_run_id, revision: row.run_revision,
        data: { trader_run_id: row.trader_run_id, analysis_id: row.market_analysis_id,
          trading_account_id: row.trading_account_id, task_mode: row.task_mode,
          status: row.run_status, updated_at: iso(row.run_updated_at_utc) },
      }),
      base(event, {
        type: 'trade_decision.created', userId: row.user_id, accountId: row.trading_account_id,
        resource: 'trade_decision', resourceId: row.id, revision: row.revision,
        data: { decision_id: row.id, analysis_id: row.market_analysis_id, trading_account_id: row.trading_account_id,
          action: row.action_kind, side: row.side, confidence: Number(row.confidence),
          status: row.status, stale_reason: row.stale_reason },
      }),
    ]
  }

  private async riskPolicy(event: ClaimedOutboxEvent) {
    const accountId = requiredId(event.payload.account_id, 'outbox_account_id_invalid')
    const row = await one<RiskPolicyRow>(this.pool,
      "SELECT p.owner_user_id user_id,CAST(p.trading_account_id AS CHAR) account_id,CAST(p.active_version_id AS CHAR) policy_version_id,p.revision FROM risk_policy_sets_v4 p WHERE p.scope='account' AND p.trading_account_id=? LIMIT 1",
      [accountId], 'outbox_risk_policy_missing')
    return base(event, {
      type: 'risk.policy.changed', userId: row.user_id, accountId: row.account_id, resource: 'risk.policy',
      resourceId: row.account_id, revision: row.revision,
      data: { account_id: row.account_id, policy_version_id: row.policy_version_id, revision: String(row.revision) },
    })
  }

  private async riskSummary(event: ClaimedOutboxEvent) {
    const accountId = requiredId(event.payload.account_id, 'outbox_account_id_invalid')
    const row = await one<RiskSummaryRow>(this.pool,
      "SELECT s.user_id,CAST(s.trading_account_id AS CHAR) account_id,s.data_complete,s.revision FROM account_risk_states s WHERE s.trading_account_id=? LIMIT 1",
      [accountId], 'outbox_risk_summary_missing')
    return base(event, {
      type: 'risk.summary.changed', userId: row.user_id, accountId: row.account_id, resource: 'risk.summary',
      resourceId: row.account_id, revision: row.revision,
      data: { account_id: row.account_id, data_complete: Boolean(row.data_complete), revision: String(row.revision) },
    })
  }

  private async riskDecision(event: ClaimedOutboxEvent) {
    const id = requiredId(event.payload.risk_decision_id, 'outbox_risk_decision_id_invalid')
    const row = await one<RiskDecisionRow>(this.pool,
      "SELECT r.id,r.user_id,CAST(r.trading_account_id AS CHAR) account_id,r.trade_decision_id decision_id,r.decision_status status,r.reject_code,r.revision FROM risk_decisions_v4 r WHERE r.id=? LIMIT 1",
      [id], 'outbox_risk_decision_missing')
    return base(event, {
      type: 'risk.decision.created', userId: row.user_id, accountId: row.account_id, resource: 'risk.decision',
      resourceId: row.id, revision: row.revision,
      data: { risk_decision_id: row.id, decision_id: row.decision_id, account_id: row.account_id,
        status: row.status, reject_code: row.reject_code },
    })
  }

  private async riskRelease(event: ClaimedOutboxEvent) {
    const id = requiredId(event.payload.manual_release_id, 'outbox_manual_release_id_invalid')
    const row = await one<RiskReleaseRow>(this.pool,
      "SELECT r.id,r.user_id,CAST(r.trading_account_id AS CHAR) account_id,r.status,r.invalidation_reason,r.revision FROM risk_manual_releases r WHERE r.id=? LIMIT 1",
      [id], 'outbox_risk_manual_release_missing')
    return base(event, {
      type: 'risk.manual_release.changed', userId: row.user_id, accountId: row.account_id,
      resource: 'risk.manual_release', resourceId: row.id, revision: row.revision,
      data: { manual_release_id: row.id, account_id: row.account_id, status: row.status,
        invalidation_reason: row.invalidation_reason, revision: String(row.revision) },
    })
  }

  private async operation(event: ClaimedOutboxEvent) {
    const id = requiredId(event.payload.operation_id, 'outbox_operation_id_invalid')
    const row = await one<OperationRow>(this.pool,
      "SELECT o.id,o.user_id,CAST(o.trading_account_id AS CHAR) account_id,o.kind,o.status,o.updated_at_utc,o.resource_id,o.error_code,o.revision FROM operations o WHERE o.id=? LIMIT 1",
      [id], 'outbox_operation_missing')
    return base(event, {
      type: 'operation.changed', userId: row.user_id, accountId: row.account_id, resource: 'operation',
      resourceId: row.id, revision: row.revision,
      data: { operation_id: row.id, kind: row.kind, status: row.status, updated_at: iso(row.updated_at_utc),
        resource_id: row.resource_id, error_code: row.error_code },
    })
  }
}

type EventBody = Omit<BrowserRealtimeEvent, 'eventId' | 'occurredAt' | 'terminalInstanceId' | 'data'>
  & Pick<BrowserRealtimeEvent, 'data'> & { eventId?: string }

function base(source: ClaimedOutboxEvent, body: EventBody): BrowserRealtimeEvent {
  return {
    eventId: body.eventId ?? source.eventId, type: body.type, occurredAt: source.occurredAt,
    userId: body.userId, accountId: body.accountId, terminalInstanceId: null,
    resource: body.resource, resourceId: body.resourceId, revision: Number(body.revision), data: body.data,
  }
}

async function one<T extends RowDataPacket>(pool: Pool, sql: string, params: Array<string | number | Date | null>, code: string) {
  const [rows] = await pool.execute<T[]>(sql, params)
  if (!rows[0]) throw new Error(code)
  return rows[0]
}

function requiredId(value: unknown, code: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 191) throw new Error(code)
  return value
}

function iso(value: Date | string) { return new Date(value).toISOString() }
function suffix(value: string, ending: string) { return (value + ':' + ending).slice(0, 191) }
