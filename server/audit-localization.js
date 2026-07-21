const ACTION_LABELS = {
  manual_open: '手动开仓',
  manual_close: '手动平仓',
  ai_execute: 'AI 信号执行',
  ai_auto_scan: 'AI 自动扫描',
  ai_auto_execute: 'AI 自动执行',
  ai_auto_execute_skipped: 'AI 自动执行跳过',
  ai_auto_execute_rejected: 'AI 自动执行拒绝',
  cancel_pending_invalid: '忽略无效撤单条件',
  cancel_pending_invalid_price: '跳过价格无效挂单',
  cancel_pending_invalid_ticket: '跳过编号无效挂单',
  ai_cancel_pending: 'AI 取消挂单',
  ai_cancel_pending_failed: 'AI 取消挂单失败',
  pending_superseded: '旧挂单已替换',
  pending_supersede_failed: '旧挂单替换失败',
  pending_expire_cancel_failed: '过期挂单取消失败',
  pending_expired: '挂单已过期',
  pending_filled: '挂单已成交',
  delivery_stale_executing: '执行状态超时待确认',
  smart_close: 'AI 智能平仓',
  smart_close_rule: '规则智能平仓',
  weekly_flatten_started: '周末风险清理开始',
  weekly_pending_cancelled: '周末系统挂单已取消',
  weekly_position_closed: '周末系统持仓已平仓',
  weekly_flatten_completed: '周末风险清理完成',
  weekly_flatten_partial: '周末风险清理未完成',
  weekly_flatten_retry: '周末风险清理重试',
  weekly_flatten_deadline_ended: '周末风险清理到期',
  weekly_flatten_unsupported_netting: '周末风险清理不支持净持仓账户',
}

const STATUS_LABELS = {
  success: '成功',
  skipped: '已跳过',
  skipped_hold: '观望',
  error: '错误',
  failed: '失败',
  rejected: '已拒绝',
  needs_confirmation: '等待确认',
  warning: '警告',
  info: '信息',
  unknown: '未知',
  ignored: '已忽略',
  cancelled: '已取消',
  filled: '已成交',
  expired: '已过期',
  uncertain: '状态待确认',
  pending: '等待处理',
  executing: '执行中',
  not_attempted: '未尝试',
  completed: '已完成',
  partial: '部分完成',
  retrying: '正在重试',
  started: '已开始',
  superseded: '已被替换',
}

const VALUE_LABELS = {
  ...STATUS_LABELS,
  buy: '买入',
  sell: '卖出',
  hold: '观望',
  close: '平仓',
  pending: '挂单',
  position: '持仓',
  inventory: '交易清单获取',
  verification: '执行结果复核',
  timer: '定时调度',
  ai: 'AI 推理',
  manual: '手动操作',
  auto_shared: '自动推理共享信号',
  analyze_auto: '手动推理自动执行',
  ai_failed: 'AI 推理失败',
  invalid_condition: '撤单条件无效',
  invalid_pending_price: '挂单价格无效',
  invalid_pending_ticket: '挂单编号无效',
  trade_send_disabled: '交易发送已关闭',
  weekly_flatten_window: '周末风险控制处理中',
  deadline_reached: '任务已到达结束时间',
  inventory_unavailable: '无法获取交易清单',
  verification_unavailable: '无法复核执行结果',
  positions_remaining: '仍有系统持仓或挂单未清理',
  unsupported_netting: '净持仓账户无法安全区分系统仓位',
  redis_unavailable: 'Redis 不可用',
  lock_lost: '任务锁已失效',
  signal_expired: '信号已过期',
  signal_already_executed_or_pending: '该信号已经执行或已有挂单，不能重复执行',
  no_active_auto_trade_config: '自动交易未开启',
  open_position_exists: '当前品种已有持仓',
  position_check_failed: '持仓检查失败',
  invalid_order_type: '订单方向无效',
  volume_exceeds_config_limit: '手数超过配置上限',
  max_open_positions_reached: '持仓数量达到上限',
  signal_price_slippage_exceeded: '信号价格与当前价格偏差过大',
  'R1.5_RR_TOO_LOW': '盈亏比低于最低要求',
  'R1.5_TP_TIER_UPGRADED': '已改用满足盈亏比要求的更远止盈档位',
  'R1.9_BELOW_MINIMUM_AFTER_RISK': '风险调整后手数低于最小可交易手数',
  'R4.4_QUOTE_STALE': 'MT5 报价已过期或时间异常',
  'R1.7_PENDING_DEVIATION': '挂单价格偏离当前报价过大',
  'R1.7_PENDING_DIRECTION': '挂单方向与当前价格关系不正确',
  'R1.4_STOP_LOSS_TOO_FAR': '止损距离超过风控上限',
  'R1.3_SL_WIDEN_VOLUME_DOWN': '止损距离已扩大并同步降低手数',
  bridge_upgrade_required_for_incremental_risk: '桥接软件版本过旧，请升级或重启最新版桥接软件',
  risk_snapshot_failed: '无法获取完整的 MT5 风险快照',
  confirmation_required: '需要人工确认',
  mt5_terminal_autotrading_disabled: 'MT5 终端自动交易已关闭',
  mt5_account_trade_disabled: 'MT5 账户禁止交易',
  mt5_account_expert_trading_disabled: 'MT5 账户禁止 EA 或脚本交易',
  'Request executed': 'MT5 已执行请求',
  'AutoTrading disabled by client': 'MT5 客户端已关闭自动交易',
  'Unsupported filling mode': 'MT5 不支持当前成交模式',
  'Invalid price': 'MT5 挂单价格无效',
  'Invalid stops': 'MT5 止损或止盈价格无效',
  'R5_SCHEMA_STOP_LIMIT_PRICE': 'Stop Limit 触发后限价无效',
  'R1.7_STOP_LIMIT_RELATION': 'Stop Limit 触发价与触发后限价关系错误',
  'R3.4_MARGIN_DATA_INCOMPLETE': 'MT5 无法计算本次订单所需保证金',
  'R3.4_PROJECTED_MARGIN_LEVEL': '下单后的预计保证金水平低于要求',
}

const ACTION_CODES = new Map(Object.entries(ACTION_LABELS).map(([code, label]) => [label, code]))
const STATUS_CODES = new Map(Object.entries(STATUS_LABELS).map(([code, label]) => [label, code]))

export function auditActionCode(value) {
  return ACTION_LABELS[value] ? value : (ACTION_CODES.get(value) || 'unknown')
}

export function auditStatusCode(value) {
  return STATUS_LABELS[value] ? value : (STATUS_CODES.get(value) || 'unknown')
}

export function auditActionLabel(value) {
  if (ACTION_LABELS[value]) return ACTION_LABELS[value]
  if (ACTION_CODES.has(value)) return value
  return '系统审计操作'
}

export function auditStatusLabel(value) {
  if (STATUS_LABELS[value]) return STATUS_LABELS[value]
  if (STATUS_CODES.has(value)) return value
  return '未知状态'
}

export function auditValueLabel(value) {
  const text = String(value ?? '').trim()
  return VALUE_LABELS[text] || text
}

const USER_TEXT_KEYS = new Set(['reason', 'message', 'error', 'risk_block', 'last_error'])

export function localizeAuditPayload(value, parentKey = '') {
  if (Array.isArray(value)) return value.map(item => localizeAuditPayload(item, parentKey))
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    const localized = auditValueLabel(value)
    if (localized !== value) return localized
    if (USER_TEXT_KEYS.has(parentKey) && /[A-Za-z]/.test(value) && !/[\u4e00-\u9fff]/.test(value)) {
      return parentKey === 'reason' || parentKey === 'risk_block'
        ? '系统执行条件未满足'
        : '系统执行异常，详细原因请查看服务器运行日志'
    }
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localizeAuditPayload(item, key)]))
}

export function shouldSkipHoldAudit(request, result, status) {
  const resultStatus = String(result?.status ?? status ?? '').toLowerCase()
  return resultStatus === 'skipped_hold'
}

export function prepareAuditRecord(action, request, result, status) {
  const actionCode = auditActionCode(action)
  const statusCode = auditStatusCode(status)
  return {
    action: auditActionLabel(action),
    status: auditStatusLabel(status),
    actionCode,
    statusCode,
    request: localizeAuditPayload(request || {}),
    result: localizeAuditPayload(result || {}),
  }
}

export function localizeAuditRow(row) {
  const prepared = prepareAuditRecord(row?.action, row?.request, row?.result, row?.status)
  return {
    ...row,
    action: prepared.action,
    status: prepared.status,
    action_code: prepared.actionCode,
    status_code: prepared.statusCode,
    request: prepared.request,
    result: prepared.result,
  }
}
