import { queryAll, queryOne } from '../db.js'
import { auditActionLabel, auditStatusLabel, formatRiskReason } from '../audit-localization.js'

function number(value) { return Number(value || 0) }
function parseJson(value, fallback = {}) {
  if (!value) return fallback
  try { return typeof value === 'string' ? JSON.parse(value) : value }
  catch { return fallback }
}

function riskDetails(row) {
  const rules = parseJson(row.rule_results_json, [])
  if (!Array.isArray(rules)) return {}
  const matched = rules.find(item => item?.code === row.reject_code || item?.rule_code === row.reject_code || item?.status === 'reject')
  return matched?.details || matched || {}
}

export async function getAdminRiskAuditOverview({ page = 1, pageSize = 20, decision = 'all' } = {}) {
  const safePage = Math.max(1, Math.trunc(Number(page) || 1))
  const safePageSize = Math.min(100, Math.max(5, Math.trunc(Number(pageSize) || 20)))
  const where = decision === 'reject' || decision === 'adjust' || decision === 'pass' ? 'WHERE decisions.decision_status = ?' : ''
  const params = where ? [decision] : []
  const [summary, globalControl, accountStates, totalRow, rows] = await Promise.all([
    queryOne(`SELECT
      (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE()) AS decisions_today,
      (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE() AND decision_status = 'reject') AS rejected_today,
      (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE() AND decision_status = 'adjust') AS adjusted_today,
      (SELECT COUNT(*) FROM risk_account_state WHERE halt_status <> 'active' OR user_kill_switch = 1 OR data_complete = 0) AS paused_accounts,
      (SELECT COUNT(*) FROM trading_accounts WHERE is_deleted = 0) AS trading_accounts,
      (SELECT COUNT(*) FROM audit_logs WHERE created_at >= CURDATE()) AS admin_actions_today`),
    queryOne('SELECT global_kill_switch, reason, changed_by, updated_at FROM global_risk_control WHERE id = 1'),
    queryAll(`SELECT accounts.id, accounts.login_account, accounts.nickname, accounts.broker_server,
      users.id AS user_id, users.nickname AS user_nickname, users.email AS user_email,
      states.halt_status, states.halt_reason, states.drawdown_pct, states.consecutive_losses,
      states.cooldown_until, states.user_kill_switch, states.data_complete, states.data_incomplete_reason,
      states.last_risk_snapshot_at
      FROM trading_accounts accounts JOIN users ON users.id = accounts.user_id
      LEFT JOIN risk_account_state states ON states.trading_account_id = accounts.id
      WHERE accounts.is_deleted = 0
      ORDER BY (COALESCE(states.halt_status, 'active') <> 'active' OR COALESCE(states.user_kill_switch, 0) = 1 OR COALESCE(states.data_complete, 0) = 0) DESC,
        accounts.updated_at DESC LIMIT 500`),
    queryOne(`SELECT COUNT(*) AS total FROM risk_decisions decisions ${where}`, params),
    queryAll(`SELECT decisions.id, decisions.order_intent_id, decisions.decision_status, decisions.reject_code,
      decisions.rule_results_json, decisions.created_at, intents.action, intents.symbol, intents.status AS execution_status,
      intents.user_id, users.nickname AS user_nickname, users.email AS user_email
      FROM risk_decisions decisions
      LEFT JOIN order_intents intents ON intents.id = decisions.order_intent_id
      LEFT JOIN users ON users.id = intents.user_id
      ${where} ORDER BY decisions.id DESC LIMIT ? OFFSET ?`, [...params, safePageSize, (safePage - 1) * safePageSize]),
  ])
  const total = number(totalRow?.total)
  return {
    summary:Object.fromEntries(Object.entries(summary || {}).map(([key, value]) => [key, number(value)])),
    global_control:globalControl ? { ...globalControl, global_kill_switch:Boolean(globalControl.global_kill_switch) } : { global_kill_switch:false, reason:'', changed_by:null, updated_at:null },
    accounts:accountStates.map(row => ({ ...row, id:number(row.id), user_id:number(row.user_id), user_kill_switch:Boolean(row.user_kill_switch), data_complete:Boolean(row.data_complete) })),
    decisions:rows.map(row => ({ ...row, id:number(row.id), order_intent_id:number(row.order_intent_id), user_id:number(row.user_id), reason:formatRiskReason(row.reject_code, riskDetails(row)) })),
    pagination:{ page:safePage, page_size:safePageSize, total, total_pages:Math.max(1, Math.ceil(total / safePageSize)) },
  }
}

export async function listAdminAuditEvents({ page = 1, pageSize = 20, search = '' } = {}) {
  const safePage = Math.max(1, Math.trunc(Number(page) || 1))
  const safePageSize = Math.min(100, Math.max(5, Math.trunc(Number(pageSize) || 20)))
  const keyword = String(search || '').trim().slice(0, 100)
  const where = keyword ? 'WHERE logs.user_email LIKE ? OR logs.user_nickname LIKE ? OR logs.action LIKE ? OR logs.detail LIKE ?' : ''
  const params = keyword ? Array(4).fill(`%${keyword}%`) : []
  const [totalRow, rows] = await Promise.all([
    queryOne(`SELECT COUNT(*) AS total FROM audit_logs logs ${where}`, params),
    queryAll(`SELECT logs.id, logs.user_id, logs.user_email, logs.user_nickname, logs.action,
      logs.target_type, logs.target_id, logs.detail, logs.ip, logs.created_at
      FROM audit_logs logs ${where} ORDER BY logs.id DESC LIMIT ? OFFSET ?`, [...params, safePageSize, (safePage - 1) * safePageSize]),
  ])
  const total = number(totalRow?.total)
  return { events:rows.map(row => ({ ...row, id:number(row.id), user_id:number(row.user_id), action_label:auditActionLabel(row.action), status_label:auditStatusLabel('info') })), pagination:{ page:safePage, page_size:safePageSize, total, total_pages:Math.max(1, Math.ceil(total / safePageSize)) } }
}
