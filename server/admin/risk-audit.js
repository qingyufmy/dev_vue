import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import { auditActionLabel, auditStatusLabel } from '../audit-localization.js'
import { buildPlatformControls, DEFAULT_RISK_POLICY, normalizePlatformRiskConfig, RISK_RULES } from '../routes/ai/risk-policy.js'

function number(value) { return Number(value || 0) }
function parseJson(value, fallback = {}) {
  if (!value) return fallback
  try { return typeof value === 'string' ? JSON.parse(value) : value }
  catch { return fallback }
}

export async function getAdminRiskAuditOverview({ accountPage = 1, accountPageSize = 8 } = {}) {
  const safeAccountPage = Math.max(1, Math.trunc(Number(accountPage) || 1))
  const safeAccountPageSize = Math.min(50, Math.max(5, Math.trunc(Number(accountPageSize) || 8)))
  const [summary, globalControl, accountTotalRow, accountStates] = await Promise.all([
    queryOne(`SELECT
      (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE()) AS decisions_today,
      (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE() AND decision_status = 'reject') AS rejected_today,
      (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE() AND decision_status = 'adjust') AS adjusted_today,
      (SELECT COUNT(*) FROM trading_accounts account
        LEFT JOIN risk_account_state state ON state.trading_account_id = account.id
        WHERE account.is_deleted = 0 AND account.observe_status = 'active' AND (
          state.halt_status <> 'active' OR state.user_kill_switch = 1 OR state.data_complete = 0
        )) AS paused_accounts,
      (SELECT COUNT(*) FROM trading_accounts
        WHERE is_deleted = 0 AND observe_status = 'active') AS trading_accounts,
      (SELECT COUNT(*) FROM audit_logs WHERE created_at >= CURDATE()) AS admin_actions_today`),
    queryOne('SELECT global_kill_switch, reason, changed_by, updated_at FROM global_risk_control WHERE id = 1'),
    queryOne('SELECT COUNT(*) AS total FROM trading_accounts WHERE is_deleted = 0'),
    queryAll(`SELECT accounts.id, accounts.login_account, accounts.nickname, accounts.broker_server,
      accounts.observe_status, accounts.anomaly_code,
      users.id AS user_id, users.nickname AS user_nickname, users.email AS user_email,
      states.halt_status, states.halt_reason, states.drawdown_pct, states.consecutive_losses,
      states.cooldown_until, states.user_kill_switch, states.data_complete, states.data_incomplete_reason,
      states.last_risk_snapshot_at
      FROM trading_accounts accounts JOIN users ON users.id = accounts.user_id
      LEFT JOIN risk_account_state states ON states.trading_account_id = accounts.id
      WHERE accounts.is_deleted = 0
      ORDER BY (accounts.observe_status IN ('paused','switched','frozen','transferred')
        OR COALESCE(states.halt_status, 'active') <> 'active'
        OR COALESCE(states.user_kill_switch, 0) = 1 OR COALESCE(states.data_complete, 0) = 0) DESC,
        accounts.updated_at DESC LIMIT ? OFFSET ?`, [safeAccountPageSize, (safeAccountPage - 1) * safeAccountPageSize]),
  ])
  const accountTotal = number(accountTotalRow?.total)
  return {
    summary:Object.fromEntries(Object.entries(summary || {}).map(([key, value]) => [key, number(value)])),
    global_control:globalControl ? { ...globalControl, global_kill_switch:Boolean(globalControl.global_kill_switch) } : { global_kill_switch:false, reason:'', changed_by:null, updated_at:null },
    accounts:accountStates.map(row => ({ ...row, id:number(row.id), user_id:number(row.user_id), user_kill_switch:Boolean(row.user_kill_switch), data_complete:Boolean(row.data_complete) })),
    account_pagination:{ page:safeAccountPage, page_size:safeAccountPageSize, total:accountTotal, total_pages:Math.max(1, Math.ceil(accountTotal / safeAccountPageSize)) },
  }
}

export async function listAdminAuditEvents({ page = 1, pageSize = 20, search = '', targetType = '' } = {}) {
  const safePage = Math.max(1, Math.trunc(Number(page) || 1))
  const safePageSize = Math.min(100, Math.max(5, Math.trunc(Number(pageSize) || 20)))
  const keyword = String(search || '').trim().slice(0, 100)
  const requestedTarget = String(targetType || '').trim().toLowerCase()
  const safeTargetType = /^[a-z0-9_]{1,64}$/.test(requestedTarget) ? requestedTarget : ''
  const conditions = ["actors.role = 'admin'", "logs.action NOT IN ('login','register')"]
  const params = []
  if (keyword) { conditions.push('(logs.user_email LIKE ? OR logs.user_nickname LIKE ? OR logs.action LIKE ? OR logs.detail LIKE ?)'); params.push(...Array(4).fill(`%${keyword}%`)) }
  if (safeTargetType) { conditions.push('logs.target_type = ?'); params.push(safeTargetType) }
  const where = `WHERE ${conditions.join(' AND ')}`
  const [totalRow, rows] = await Promise.all([
    queryOne(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN logs.created_at >= CURDATE() THEN 1 ELSE 0 END) AS today,
      COUNT(DISTINCT logs.user_id) AS actors,
      COUNT(DISTINCT logs.target_type) AS target_types
      FROM audit_logs logs LEFT JOIN users actors ON actors.id = logs.user_id ${where}`, params),
    queryAll(`SELECT logs.id, logs.user_id, logs.user_email, logs.user_nickname, logs.action,
      logs.target_type, logs.target_id, logs.detail, logs.ip, logs.created_at
      FROM audit_logs logs LEFT JOIN users actors ON actors.id = logs.user_id ${where}
      ORDER BY logs.id DESC LIMIT ? OFFSET ?`, [...params, safePageSize, (safePage - 1) * safePageSize]),
  ])
  const total = number(totalRow?.total)
  return {
    events:rows.map(row => ({ ...row, id:number(row.id), user_id:number(row.user_id), action_label:auditActionLabel(row.action), status_label:auditStatusLabel('info') })),
    summary:{ total, today:number(totalRow?.today), actors:number(totalRow?.actors), target_types:number(totalRow?.target_types) },
    pagination:{ page:safePage, page_size:safePageSize, total, total_pages:Math.max(1, Math.ceil(total / safePageSize)) },
  }
}

async function ensurePlatformRiskPolicySet(actorId) {
  let policySet=await queryOne("SELECT * FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id LIMIT 1")
  if(policySet)return policySet
  const now=beijingNow()
  const inserted=await queryRun("INSERT INTO risk_policy_sets (scope, owner_user_id, name, status, created_at, updated_at) VALUES ('platform', 0, '平台全局风控', 'active', ?, ?)",[now,now])
  await queryRun(`INSERT INTO risk_policy_versions (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at)
    VALUES (?, 1, ?, ?, '建立平台默认规则', ?, ?)`,[inserted.insertId,JSON.stringify(DEFAULT_RISK_POLICY),actorId,now,now])
  return {id:inserted.insertId,name:'平台全局风控',active_version_id:null}
}

export async function getAdminPlatformRiskPolicy() {
  const policySet=await queryOne("SELECT * FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id LIMIT 1")
  const version=policySet?await queryOne('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1',[policySet.id]):null
  const raw=parseJson(version?.config_json,{})
  const normalized=normalizePlatformRiskConfig({currentValues:raw.values||raw.defaults||raw,currentControls:raw.controls||{}})
  return {policy_set:policySet||null,version:version?{id:number(version.id),version_no:number(version.version_no),effective_at:version.effective_at,created_at:version.created_at,change_reason:version.change_reason}:null,values:normalized.values,controls:buildPlatformControls(normalized),rule_metadata:RISK_RULES}
}

export async function saveAdminPlatformRiskPolicy({ actorId, values = {}, controls = {}, reason = '' } = {}) {
  const policySet=await ensurePlatformRiskPolicySet(actorId)
  return withTransaction(async run=>{
    const [[current]]=await run('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1 FOR UPDATE',[policySet.id])
    const raw=parseJson(current?.config_json,{})
    const normalized=normalizePlatformRiskConfig({currentValues:raw.values||raw.defaults||raw,currentControls:raw.controls||{},valueChanges:values,controlChanges:controls})
    const now=beijingNow(),versionNo=number(current?.version_no)+1
    const [insert]=await run(`INSERT INTO risk_policy_versions (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,[policySet.id,versionNo,JSON.stringify(normalized),actorId,String(reason||'管理员更新平台风控').slice(0,255),now,now])
    await run('UPDATE risk_policy_sets SET active_version_id = ?, updated_at = ? WHERE id = ?',[insert.insertId,now,policySet.id])
    return {active_version_id:number(insert.insertId),version_no:versionNo,effective_at:now}
  })
}
