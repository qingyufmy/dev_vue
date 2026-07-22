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
  portfolio_alignment: '持仓与挂单对齐',
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
  auto_trade_disabled: '当前订阅没有开启自动执行',
  bridge_offline: '用户的 MT5 桥接当前未连接',
  user_quote_unavailable: '无法获取用户 MT5 的有效报价',
  stop_loss_missing: 'AI 信号缺少有效止损价格',
  invalid_stop_loss_direction: '止损价格方向与订单方向不一致',
  take_profit_target_missing: '所选止盈档位没有有效目标价格',
  invalid_take_profit_direction: '止盈价格方向与订单方向不一致',
  pending_list_unavailable: '无法读取当前 MT5 挂单列表',
  pending_list_confirm_unavailable: '替换旧挂单后无法复核最新挂单列表',
  pending_list_confirm_failed: '替换旧挂单后的挂单复核失败',
  pending_supersede_incomplete: '同方向旧挂单尚未完全替换',
  pending_limit_reached: '当前品种的挂单数量已达到限制',
  private_portfolio_context_unavailable: '无法获取私有策略所需的持仓与挂单数据',
  portfolio_state_unavailable: '无法读取当前账户的持仓与挂单，本次未执行',
  opposite_position_exists: '当前账户已有反向持仓，本次不新增仓位',
  existing_position_no_add: '当前账户已有同向持仓，策略未建议加仓',
  reference_position_not_matched: '账户实际持仓与平台参考组合不一致，本次不跟随加仓',
  existing_pending_kept: '当前策略的原挂单仍然有效，继续保留',
  reference_pending_not_matched: '账户中未找到平台策略要管理的对应挂单',
  existing_pending_no_replace: '当前策略已有同向挂单，未收到替换指令',
  pending_cancel_failed: '策略挂单取消失败，本次未继续执行',
  pending_cancelled: '策略旧挂单已取消',
  subscription_inactive: '策略订阅当前未启用',
  outside_schedule: '当前不在自动推理运行时段内',
  system_execution_exception: '系统执行异常，详细信息已记录',
  lock_lost_before_supersede_cancel: '任务执行权已失效，未继续替换旧挂单',
  lock_lost_before_pending_confirm: '任务执行权已失效，未继续复核挂单',
  lock_lost_before_send: '任务执行权已失效，订单未发送到 MT5',
  'R1.5_RR_TOO_LOW': '盈亏比低于最低要求',
  'R1.5_TP_TIER_UPGRADED': '已改用满足盈亏比要求的更远止盈档位',
  'R1.9_BELOW_MINIMUM_AFTER_RISK': '风险调整后手数低于最小可交易手数',
  'R4.4_QUOTE_STALE': 'MT5 报价已过期或时间异常',
  'R1.7_PENDING_DEVIATION': '挂单价格偏离当前报价过大',
  'R1.7_PENDING_PRICE_ABNORMAL': '挂单触发价明显异常',
  'R1.7_PENDING_DIRECTION': '挂单方向与当前价格关系不正确',
  'R4.6_EXECUTION_PRICE_DEVIATION': '当前价格超出允许执行区间',
  'PX.3_EXECUTION_PRICE_TOLERANCE': '已按百分比换算 MT5 下单偏差',
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
  'R5_SCHEMA_AI_POSITION_SIZE_TIER': 'AI 返回的仓位档位无效',
  'R1.7_STOP_LIMIT_RELATION': 'Stop Limit 触发价与触发后限价关系错误',
  'R3.4_MARGIN_DATA_INCOMPLETE': 'MT5 无法计算本次订单所需保证金',
  'R3.4_PROJECTED_MARGIN_LEVEL': '下单后的预计保证金水平低于要求',
  'R1_INSTRUMENT_DATA_INCOMPLETE': '品种交易参数不完整',
  'R1_SYMBOL_TRADE_DISABLED': '该品种当前禁止交易',
  'R1.1_SYMBOL_NOT_ALLOWED': '该品种不在平台允许交易范围内',
  'R1.2_STOP_LOSS_REQUIRED': '订单缺少有效止损',
  'R1.5_TAKE_PROFIT_REQUIRED': '订单缺少有效止盈',
  'R1.6_SL_TP_DIRECTION': '止损或止盈价格方向错误',
  'R1.9_AI_VOLUME_OUT_OF_RANGE': '订单执行上限不符合 MT5 品种手数规则',
  'R1.9_VOLUME_INCREASE_FORBIDDEN': '风控禁止超过账户单笔手数上限',
  'R1.9_VOLUME_INVALID': '订单手数不符合品种交易规则',
  'R1.10_RISK_DATA_INVALID': '账户或品种风险数据无效',
  'R2.2_MIN_OPEN_INTERVAL': '距离上次开仓时间过短',
  'R2.3_DAILY_OPEN_COUNT': '当日开仓次数已达到上限',
  'R2.4_PRICE_TIME_DUPLICATE': '检测到时间和价格均相近的重复订单',
  'R3.1_DAILY_LOSS_LIMIT': '账户已达到每日亏损上限',
  'R3.2_CONSECUTIVE_LOSS_COOLDOWN': '连续亏损已触发交易冷却',
  'R3.2_LOSS_COOLDOWN': '账户仍处于连续亏损冷却期',
  'R3.3_MAX_DRAWDOWN': '账户回撤已达到限制',
  'R3_ACCOUNT_HALTED': '账户风控当前处于暂停状态',
  'R3_RISK_DATA_INCOMPLETE': '账户风险数据尚不完整',
  'R4_QUOTE_INVALID': '当前 MT5 报价无效',
  'R4.2_WEEKEND_PROTECTION': '当前处于周末保护时段，禁止新增仓位',
  'R4.3_SIGNAL_EXPIRED': '推理信号已经超过有效期',
  'R4.5_SPREAD_TOO_WIDE': '当前点差超过允许上限',
  'R6_ACCOUNT_NOT_FOUND': '未找到当前 MT5 对应的交易账户',
  'R6_ACCOUNT_PAUSED': '当前交易账户已暂停',
  'R6_ACCOUNT_TRANSFERRED': '该 MT5 账户已切换到其他平台账号',
  'R6_GLOBAL_KILL_SWITCH': '平台紧急停止已开启',
  'R6_USER_KILL_SWITCH': '账户紧急停止已开启',
  'R6_ACCOUNT_TRADE_PERMISSION_REQUIRED': '当前 MT5 账户没有完整交易权限',
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

function displayNumber(value, digits = 3) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return number.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

export function formatRiskReason(code, details = {}) {
  const rawCode = String(code || '').trim()
  const label = auditValueLabel(rawCode)
  const base = label === rawCode ? '风控条件未满足' : label
  if (rawCode === 'R1.9_AI_VOLUME_OUT_OF_RANGE') return `${base}：执行上限 ${displayNumber(details.volume)} 手，允许范围 ${displayNumber(details.minimum)}～${displayNumber(details.maximum)} 手，步进 ${displayNumber(details.step)} 手`
  if (rawCode === 'R1.9_BELOW_MINIMUM_AFTER_RISK') return `${base}：风险计算后为 ${displayNumber(details.volume)} 手，最低可交易 ${displayNumber(details.minimum)} 手`
  if (rawCode === 'R1.7_PENDING_DIRECTION') return `${base}：触发价 ${displayNumber(details.trigger_price)}，当前价 ${displayNumber(details.current_price)}`
  if (rawCode === 'R1.7_STOP_LIMIT_RELATION') return `${base}：触发价 ${displayNumber(details.trigger_price)}，触发后限价 ${displayNumber(details.stop_limit_price)}`
  if (rawCode === 'R4.4_QUOTE_STALE') return `${base}：报价年龄 ${displayNumber(details.quote_age_seconds)} 秒，允许上限 ${displayNumber(details.maximum_seconds)} 秒`
  if (rawCode === 'R4.5_SPREAD_TOO_WIDE') return `${base}：当前 ${displayNumber(details.spread_points)} 点`
  if (rawCode === 'R4.6_EXECUTION_PRICE_DEVIATION') return `${base}：当前价 ${displayNumber(details.current_price)}，允许区间 ${displayNumber(details.allowed_min)}～${displayNumber(details.allowed_max)}，最大偏差 ${displayNumber(details.maximum_pct)}%`
  if (rawCode === 'R2.2_MIN_OPEN_INTERVAL') return `${base}：还需等待 ${displayNumber(details.remaining_seconds, 0)} 秒`
  if (rawCode === 'R2.3_DAILY_OPEN_COUNT') return `${base}：当前 ${displayNumber(details.count, 0)} 次，上限 ${displayNumber(details.limit, 0)} 次`
  if (rawCode === 'R3.1_DAILY_LOSS_LIMIT') return `${base}：当前亏损 ${displayNumber(details.daily_loss_pct ?? details.loss_pct)}%，上限 ${displayNumber(details.limit_pct ?? details.daily_loss_limit_pct)}%`
  if (rawCode === 'R3.2_LOSS_COOLDOWN' && details.until) return `${base}：冷却至 ${details.until}`
  if (rawCode === 'R3.3_MAX_DRAWDOWN') return `${base}：当前回撤 ${displayNumber(details.drawdown_pct)}%，上限 ${displayNumber(details.limit_pct)}%`
  if (rawCode === 'invalid_stop_loss_direction') return `${base}：止损 ${displayNumber(details.stop_loss)}，入场参考价 ${displayNumber(details.entry_price)}`
  if (rawCode === 'invalid_take_profit_direction') return `${base}：止盈 ${displayNumber(details.take_profit)}，入场参考价 ${displayNumber(details.entry_price)}`
  if (rawCode === 'pending_supersede_incomplete') return `${base}：仍有 ${displayNumber(details.remaining_same_direction, 0)} 个同向挂单未取消`
  if (rawCode === 'pending_limit_reached') return `${base}：当前 ${displayNumber(details.remaining, 0)} 个，上限 ${displayNumber(details.maximum, 0)} 个`
  if (rawCode === 'opposite_position_exists') return `${base}：检测到 ${displayNumber(details.count, 0)} 个反向持仓`
  if (rawCode === 'existing_position_no_add') return `${base}：当前已有 ${displayNumber(details.count, 0)} 个同向持仓`
  if (rawCode === 'existing_pending_kept') return `${base}：继续保留 ${displayNumber(details.count, 0)} 个当前策略挂单`
  if (rawCode === 'existing_pending_no_replace') return `${base}：当前已有 ${displayNumber(details.count, 0)} 个同向挂单`
  if (rawCode === 'pending_cancelled') return `${base}：已取消 ${displayNumber(details.count, 0)} 个当前策略挂单`
  if ((rawCode === 'R6_GLOBAL_KILL_SWITCH' || rawCode === 'R6_USER_KILL_SWITCH') && details.reason) return `${base}：${details.reason}`
  return base
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
