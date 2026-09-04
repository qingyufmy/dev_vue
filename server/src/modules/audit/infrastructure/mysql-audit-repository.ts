import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { AuditRepository, AuditRepositoryPage } from '../application/audit-ports.js'
import type {
  AuditActor, AuditCategory, AuditEventDetail, AuditEventSummary, AuditFilter, AuditLink,
  AuditSourceKind, AuditStatus, AuditTraceNode,
} from '../domain/audit.js'

interface EventRow extends RowDataPacket {
  source_kind: AuditSourceKind; source_id: string; account_id: string | null; category: AuditCategory; actor: AuditActor
  action: string; status: AuditStatus; raw_summary: string | null; reason_code: string | null; symbol: string | null
  occurred_at_utc: Date; terminal_timezone_offset_minutes: number | null; correlation_id: string | null
}
interface SummaryRow extends RowDataPacket { total_count: number; succeeded_count: number; rejected_count: number; failed_count: number; uncertain_count: number; active_count: number }
interface TraceRow extends RowDataPacket {
  stage: AuditTraceNode['stage']; status: AuditStatus; source_kind: string; source_id: string; action: string
  detail: string | null; reason_code: string | null; occurred_at_utc: Date
}
interface IdRow extends RowDataPacket { operation_id: string | null }

const FEED = `
  SELECT 'analysis_run' source_kind,r.id source_id,NULL account_id,'analysis' category,
    IF(r.trigger_type='manual','user','system') actor,CONCAT('analysis.',r.trigger_type) action,
    CASE r.status WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running' WHEN 'succeeded' THEN 'succeeded'
      WHEN 'failed' THEN 'failed' ELSE 'cancelled' END status,
    r.standard_symbol raw_summary,r.error_code reason_code,r.standard_symbol symbol,r.updated_at_utc occurred_at_utc,
    NULL terminal_timezone_offset_minutes,r.id correlation_id
  FROM ai_analysis_runs r WHERE r.user_id=?
  UNION ALL
  SELECT 'trader_run',r.id,CAST(r.trading_account_id AS CHAR),'trading','ai','trader.evaluate',
    CASE r.status WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running' WHEN 'succeeded' THEN 'succeeded'
      WHEN 'failed' THEN 'failed' ELSE 'cancelled' END,
    r.task_mode,r.error_code,NULL,r.updated_at_utc,NULL,
    COALESCE((SELECT rd.operation_id FROM trade_decisions d INNER JOIN risk_decisions_v4 rd ON rd.trade_decision_id=d.id
      WHERE d.trader_run_id=r.id AND rd.operation_id IS NOT NULL LIMIT 1),r.id)
  FROM ai_trader_runs r WHERE r.user_id=?
  UNION ALL
  SELECT 'risk_decision',r.id,CAST(r.trading_account_id AS CHAR),'risk','system','risk.review',
    IF(r.decision_status='approved','succeeded','rejected'),r.decision_status,r.reject_code,NULL,r.created_at_utc,NULL,
    COALESCE(r.operation_id,r.id)
  FROM risk_decisions_v4 r WHERE r.user_id=?
  UNION ALL
  SELECT 'operation',o.id,CAST(o.trading_account_id AS CHAR),'execution',
    IF(o.source_type IN ('user_command','strategy_distribution','distribution_close'),'user','system'),o.kind,
    CASE o.status WHEN 'accepted' THEN 'queued' WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running'
      WHEN 'succeeded' THEN 'succeeded' WHEN 'partially_succeeded' THEN 'succeeded' WHEN 'rejected' THEN 'rejected'
      WHEN 'failed' THEN 'failed' WHEN 'uncertain' THEN 'uncertain' ELSE 'cancelled' END,
    COALESCE(o.resource_id,o.source_id),o.error_code,NULL,o.updated_at_utc,NULL,o.id
  FROM operations o WHERE o.user_id=?
  UNION ALL
  SELECT 'bridge_command',c.id,CAST(c.trading_account_id AS CHAR),'terminal','bridge',c.action,
    CASE c.status WHEN 'queued' THEN 'queued' WHEN 'dispatched' THEN 'running' WHEN 'accepted' THEN 'running'
      WHEN 'reconciling' THEN 'running' WHEN 'succeeded' THEN 'succeeded' WHEN 'rejected' THEN 'rejected'
      WHEN 'failed' THEN 'failed' ELSE 'uncertain' END,
    c.terminal_code,c.error_code,NULL,c.updated_at_utc,NULL,i.operation_id
  FROM bridge_commands_v4 c INNER JOIN execution_intents i ON i.id=c.execution_intent_id WHERE c.user_id=?
  UNION ALL
  SELECT 'risk_policy_change',CAST(c.id AS CHAR),CAST(p.trading_account_id AS CHAR),'configuration','user',
    CONCAT('risk.policy.',c.change_class),'succeeded',c.field_code,NULL,NULL,c.changed_at_utc,NULL,CAST(p.id AS CHAR)
  FROM risk_policy_change_items_v4 c INNER JOIN risk_policy_sets_v4 p ON p.id=c.policy_set_id
  WHERE c.requested_by_user_id=? AND p.scope='account'
  UNION ALL
  SELECT 'risk_manual_release',r.id,CAST(r.trading_account_id AS CHAR),'risk','user','risk.manual_release',
    IF(r.status='active','succeeded','info'),r.reason,r.invalidation_reason,NULL,COALESCE(r.invalidated_at_utc,r.created_at_utc),NULL,r.id
  FROM risk_manual_releases r WHERE r.user_id=?
  UNION ALL
  SELECT 'terminal_trade',t.id,CAST(t.trading_account_id AS CHAR),'terminal','bridge','terminal.trade.closed',
    IF(t.evidence_status='complete','succeeded','uncertain'),CONCAT(t.primary_ticket,' · ',t.net_profit),
    IF(t.evidence_status='complete',NULL,CONCAT('trade_evidence_',t.evidence_status)),t.symbol,
    COALESCE(t.closed_at_utc,t.updated_at_utc),t.terminal_timezone_offset_minutes,NULL
  FROM account_trade_records_v4 t WHERE t.user_id=? AND t.status='closed'`

const EVENT_COLUMNS = `f.source_kind,f.source_id,f.account_id,f.category,f.actor,f.action,f.status,
  f.raw_summary,f.reason_code,f.symbol,f.occurred_at_utc,f.terminal_timezone_offset_minutes,f.correlation_id`

export class MysqlAuditRepository implements AuditRepository {
  constructor(private readonly pool: Pool) {}

  async ownsAccount(userId: number, accountId: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM trading_account_ownerships WHERE user_id=? AND trading_account_id=?
        AND role='owner' AND revoked_at_utc IS NULL LIMIT 1`, [userId, accountId])
    return Boolean(rows[0])
  }

  async list(userId: number, filter: AuditFilter): Promise<AuditRepositoryPage> {
    const scoped = criteria(filter, true)
    const [rows] = await this.pool.execute<EventRow[]>(
      `SELECT ${EVENT_COLUMNS} FROM (${FEED}) f WHERE ${scoped.sql}
       ORDER BY f.occurred_at_utc DESC,f.source_kind DESC,f.source_id DESC LIMIT ?`,
      [...users(userId), ...scoped.params, filter.limit + 1],
    )
    const summaryScope = criteria(filter, false)
    const [summaryRows] = await this.pool.execute<SummaryRow[]>(
      `SELECT COUNT(*) total_count,SUM(f.status='succeeded') succeeded_count,SUM(f.status='rejected') rejected_count,
        SUM(f.status='failed') failed_count,SUM(f.status='uncertain') uncertain_count,
        SUM(f.status IN ('queued','running')) active_count FROM (${FEED}) f WHERE ${summaryScope.sql}`,
      [...users(userId), ...summaryScope.params],
    )
    return {
      items: rows.slice(0, filter.limit).map(event), hasMore: rows.length > filter.limit,
      summary: auditSummary(summaryRows[0]),
    }
  }

  async find(userId: number, sourceKind: AuditSourceKind, sourceId: string): Promise<AuditEventDetail | null> {
    const [rows] = await this.pool.execute<EventRow[]>(
      `SELECT ${EVENT_COLUMNS} FROM (${FEED}) f WHERE f.source_kind=? AND f.source_id=? LIMIT 1`,
      [...users(userId), sourceKind, sourceId],
    )
    const selected = rows[0] ? event(rows[0]) : null
    if (!selected) return null
    const operationId = await this.operationId(userId, sourceKind, sourceId)
    const trace = operationId ? await this.operationTrace(userId, operationId) : [traceFromEvent(selected)]
    if (!trace.some(node => node.sourceKind === sourceKind && node.sourceId === sourceId)) trace.unshift(traceFromEvent(selected))
    return { event: selected, trace, evidence: evidence(selected), links: links(trace, selected) }
  }

  private async operationId(userId: number, kind: AuditSourceKind, id: string) {
    if (kind === 'operation') return id
    const queries: Partial<Record<AuditSourceKind, string>> = {
      bridge_command: `SELECT i.operation_id FROM bridge_commands_v4 c INNER JOIN execution_intents i ON i.id=c.execution_intent_id WHERE c.id=? AND c.user_id=? LIMIT 1`,
      risk_decision: `SELECT operation_id FROM risk_decisions_v4 WHERE id=? AND user_id=? LIMIT 1`,
      trader_run: `SELECT r.operation_id FROM trade_decisions d INNER JOIN risk_decisions_v4 r ON r.trade_decision_id=d.id WHERE d.trader_run_id=? AND d.user_id=? AND r.operation_id IS NOT NULL LIMIT 1`,
    }
    const sql = queries[kind]
    if (!sql) return null
    const [rows] = await this.pool.execute<IdRow[]>(sql, [id, userId])
    return rows[0]?.operation_id ?? null
  }

  private async operationTrace(userId: number, operationId: string): Promise<AuditTraceNode[]> {
    const [rows] = await this.pool.execute<TraceRow[]>(`
      SELECT 'analysis' stage,IF(ar.status='succeeded','succeeded',IF(ar.status='failed','failed','running')) status,
        'market_analysis' source_kind,ma.id source_id,'analysis.completed' action,ma.summary detail,ar.error_code reason_code,ma.created_at_utc occurred_at_utc
      FROM operations o INNER JOIN execution_intents i ON i.operation_id=o.id
        INNER JOIN trade_decisions d ON d.id=i.trade_decision_id INNER JOIN market_analyses ma ON ma.id=d.market_analysis_id
        INNER JOIN ai_analysis_runs ar ON ar.id=ma.analysis_run_id WHERE o.id=? AND o.user_id=?
      UNION ALL
      SELECT 'trader',IF(d.status IN ('accepted','proposed'),'succeeded',IF(d.status='risk_rejected','rejected','cancelled')),
        'trade_decision',d.id,d.action_kind,d.summary,d.stale_reason,d.created_at_utc
      FROM operations o INNER JOIN execution_intents i ON i.operation_id=o.id INNER JOIN trade_decisions d ON d.id=i.trade_decision_id WHERE o.id=? AND o.user_id=?
      UNION ALL
      SELECT 'risk',IF(r.decision_status='approved','succeeded','rejected'),'risk_decision',r.id,'risk.review',r.decision_status,r.reject_code,r.created_at_utc
      FROM operations o INNER JOIN execution_intents i ON i.operation_id=o.id INNER JOIN risk_decisions_v4 r ON r.id=i.risk_decision_id WHERE o.id=? AND o.user_id=?
      UNION ALL
      SELECT 'operation',CASE o.status WHEN 'accepted' THEN 'queued' WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running' WHEN 'succeeded' THEN 'succeeded'
        WHEN 'partially_succeeded' THEN 'succeeded' WHEN 'rejected' THEN 'rejected' WHEN 'failed' THEN 'failed' WHEN 'uncertain' THEN 'uncertain' ELSE 'cancelled' END,
        'operation',o.id,o.kind,COALESCE(o.resource_id,o.source_id),o.error_code,o.updated_at_utc FROM operations o WHERE o.id=? AND o.user_id=?
      UNION ALL
      SELECT 'intent',CASE i.status WHEN 'preparing' THEN 'running' WHEN 'risk_pending' THEN 'running' WHEN 'prepared' THEN 'queued' WHEN 'dispatching' THEN 'running'
        WHEN 'awaiting_result' THEN 'running' WHEN 'reconciling' THEN 'running' WHEN 'succeeded' THEN 'succeeded' WHEN 'rejected' THEN 'rejected'
        WHEN 'failed' THEN 'failed' WHEN 'uncertain' THEN 'uncertain' ELSE 'cancelled' END,
        'execution_intent',i.id,i.action_kind,i.source_type,i.error_code,i.updated_at_utc
      FROM execution_intents i INNER JOIN operations o ON o.id=i.operation_id WHERE o.id=? AND o.user_id=?
      UNION ALL
      SELECT 'bridge',CASE c.status WHEN 'queued' THEN 'queued' WHEN 'dispatched' THEN 'running' WHEN 'accepted' THEN 'running' WHEN 'reconciling' THEN 'running'
        WHEN 'succeeded' THEN 'succeeded' WHEN 'rejected' THEN 'rejected' WHEN 'failed' THEN 'failed' ELSE 'uncertain' END,
        'bridge_command',c.id,c.action,c.terminal_code,c.error_code,c.updated_at_utc
      FROM bridge_commands_v4 c INNER JOIN execution_intents i ON i.id=c.execution_intent_id INNER JOIN operations o ON o.id=i.operation_id WHERE o.id=? AND o.user_id=?
      UNION ALL
      SELECT 'terminal',CASE x.status WHEN 'succeeded' THEN 'succeeded' WHEN 'rejected' THEN 'rejected' WHEN 'failed' THEN 'failed' ELSE 'uncertain' END,
        'execution_outcome',x.id,CONCAT('terminal.',x.resource_kind),x.ticket,NULL,x.updated_at_utc
      FROM execution_outcomes x INNER JOIN execution_intents i ON i.id=x.execution_intent_id INNER JOIN operations o ON o.id=i.operation_id WHERE o.id=? AND o.user_id=?
      ORDER BY occurred_at_utc,source_kind,source_id`, [operationId, userId, operationId, userId, operationId, userId,
        operationId, userId, operationId, userId, operationId, userId, operationId, userId])
    return rows.map(trace)
  }
}

function users(userId: number) { return [userId, userId, userId, userId, userId, userId, userId, userId] }

function criteria(filter: AuditFilter, includeCursor: boolean) {
  const clauses = ['f.occurred_at_utc>=?', 'f.occurred_at_utc<=?', 'f.occurred_at_utc<=?']
  const params: Array<string | number> = [filter.fromUtc, filter.toUtc, filter.capturedEnd]
  if (filter.accountId) { clauses.push('f.account_id=?'); params.push(filter.accountId) }
  if (filter.category) { clauses.push('f.category=?'); params.push(filter.category) }
  if (filter.status) { clauses.push('f.status=?'); params.push(filter.status) }
  if (filter.actor) { clauses.push('f.actor=?'); params.push(filter.actor) }
  if (filter.query) {
    clauses.push("(f.source_id LIKE ? ESCAPE '\\\\' OR f.action LIKE ? ESCAPE '\\\\' OR COALESCE(f.reason_code,'') LIKE ? ESCAPE '\\\\' OR COALESCE(f.symbol,'') LIKE ? ESCAPE '\\\\' OR COALESCE(f.raw_summary,'') LIKE ? ESCAPE '\\\\')")
    const query = `%${escapeLike(filter.query)}%`; params.push(query, query, query, query, query)
  }
  if (includeCursor && filter.cursor) {
    clauses.push('(f.occurred_at_utc<? OR (f.occurred_at_utc=? AND (f.source_kind<? OR (f.source_kind=? AND f.source_id<?))))')
    params.push(filter.cursor.occurredAt, filter.cursor.occurredAt, filter.cursor.sourceKind, filter.cursor.sourceKind, filter.cursor.sourceId)
  }
  return { sql: clauses.join(' AND '), params }
}

function event(row: EventRow): AuditEventSummary {
  return {
    sourceKind: row.source_kind, sourceId: row.source_id, accountId: row.account_id, category: row.category,
    actor: row.actor, action: row.action, status: row.status, title: title(row.source_kind, row.action),
    summary: summary(row), reasonCode: row.reason_code, symbol: row.symbol, occurredAt: iso(row.occurred_at_utc),
    terminalTimezoneOffsetMinutes: row.terminal_timezone_offset_minutes === null ? null : Number(row.terminal_timezone_offset_minutes),
    correlationId: row.correlation_id,
  }
}

function trace(row: TraceRow): AuditTraceNode {
  return { stage: row.stage, status: row.status, sourceKind: row.source_kind, sourceId: row.source_id,
    title: traceTitle(row.stage, row.action), detail: row.detail ?? '暂无补充说明', reasonCode: row.reason_code,
    occurredAt: iso(row.occurred_at_utc) }
}
function traceFromEvent(value: AuditEventSummary): AuditTraceNode {
  const stage = value.category === 'analysis' ? 'analysis' : value.category === 'trading' ? 'trader'
    : value.category === 'risk' || value.category === 'configuration' ? 'risk'
      : value.category === 'execution' ? 'operation' : value.sourceKind === 'bridge_command' ? 'bridge' : 'terminal'
  return { stage, status: value.status, sourceKind: value.sourceKind, sourceId: value.sourceId,
    title: value.title, detail: value.summary, reasonCode: value.reasonCode, occurredAt: value.occurredAt }
}
function evidence(value: AuditEventSummary) {
  return [
    { label: '来源类型', value: value.sourceKind }, { label: '来源标识', value: value.sourceId },
    ...(value.accountId ? [{ label: '交易账户', value: value.accountId }] : []),
    ...(value.symbol ? [{ label: '交易品种', value: value.symbol }] : []),
    ...(value.reasonCode ? [{ label: '原因代码', value: value.reasonCode }] : []),
    ...(value.correlationId ? [{ label: '关联标识', value: value.correlationId }] : []),
  ]
}
function links(nodes: AuditTraceNode[], selected: AuditEventSummary): AuditLink[] {
  const result: AuditLink[] = []
  const add = (kind: AuditLink['kind'], id: string, label: string) => { if (!result.some(item => item.kind === kind && item.id === id)) result.push({ kind, id, label }) }
  for (const node of nodes) {
    if (node.sourceKind === 'market_analysis') add('analysis', node.sourceId, '查看行情分析')
    if (node.sourceKind === 'trade_decision') add('trader', node.sourceId, '查看交易员决策')
    if (node.sourceKind === 'risk_decision') add('risk', node.sourceId, '查看风控评审')
    if (node.sourceKind === 'operation') add('operation', node.sourceId, '查看执行操作')
  }
  if (selected.sourceKind === 'terminal_trade') add('trade', selected.sourceId, '查看交易记录')
  return result
}
function title(kind: AuditSourceKind, action: string) {
  if (kind === 'analysis_run') return action === 'analysis.manual' ? '手动行情分析' : '自动行情分析'
  if (kind === 'trader_run') return 'AI 交易员账户评估'
  if (kind === 'risk_decision') return '确定性风控评审'
  if (kind === 'operation') return '交易操作'
  if (kind === 'bridge_command') return '终端执行指令'
  if (kind === 'risk_policy_change') return '账户风控规则调整'
  if (kind === 'risk_manual_release') return '账户风控手动解除'
  return '终端成交记录'
}
function traceTitle(stage: AuditTraceNode['stage'], action: string) {
  return ({ analysis: 'AI 分析师', trader: 'AI 交易员', risk: '服务端风控', operation: '执行操作', intent: '执行意图', bridge: 'Bridge 指令', terminal: '终端结果' })[stage] + ` · ${action}`
}
function summary(row: EventRow) {
  if (row.source_kind === 'risk_decision') return row.status === 'rejected' ? '风控未通过' : '风控已通过'
  if (row.source_kind === 'terminal_trade') return `票据 ${row.raw_summary ?? row.source_id}`
  return row.raw_summary || row.action
}
function auditSummary(row?: SummaryRow) {
  return { total: Number(row?.total_count ?? 0), succeeded: Number(row?.succeeded_count ?? 0), rejected: Number(row?.rejected_count ?? 0),
    failed: Number(row?.failed_count ?? 0), uncertain: Number(row?.uncertain_count ?? 0), active: Number(row?.active_count ?? 0) }
}
function escapeLike(value: string) { return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') }
function iso(value: Date | string) { return new Date(value).toISOString() }
