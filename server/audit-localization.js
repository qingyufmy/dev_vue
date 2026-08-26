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
  ai_delivery_recovery_skipped: '历史信号恢复跳过',
  ai_delivery_recovery_summary: '历史信号恢复汇总',
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
  system_config_updated: '系统配置已更新',
  system_config_batch_updated: '系统配置批量更新',
  system_config_deleted: '系统配置项已删除',
  system_config_category_deleted: '系统配置分类已清空',
  referral_rules_updated: '返佣规则已更新',
  payment_trc20_config_updated: 'TRC-20 收款配置已更新',
  admin_user_runtime_updated: '用户运行权限已更新',
  admin_user_profile_updated: '用户档案已更新',
  trading_account_approved: '交易账户已审核',
  observer_source_account_created: '观摩源账户已创建',
  risk_recovery_approved: '风险恢复申请已批准',
  risk_recovery_requested: '风险恢复申请已提交',
  strategy_deleted: '策略已删除',
  user_anonymized: '用户资料已匿名化',
  position_management_control_updated: '全局持仓管理规则已更新',
  admin_user_subscription_updated: '用户策略订阅已更新',
  admin_position_protection_job_created: '已创建持仓保护任务',
  admin_position_protection_job_retried: '已重试持仓保护任务',
  observer_source_created: '观摩源已创建',
  observer_source_updated: '观摩源已更新',
  observer_source_deleted: '观摩源已删除',
  ai_model_profile_created: 'AI 模型配置已创建',
  ai_model_profile_updated: 'AI 模型配置已更新',
  ai_model_profile_deleted: 'AI 模型配置已删除',
  ai_model_profile_default_changed: '默认 AI 模型已调整',
  ai_strategy_created: 'AI 策略已创建',
  ai_strategy_updated: 'AI 策略已更新',
  trading_account_created: '交易账户已创建',
  trading_account_updated: '交易账户已更新',
  trading_account_deleted: '交易账户已删除',
  ai_strategy_subscription_created: '策略订阅已创建',
  ai_strategy_subscription_updated: '策略订阅已更新',
  ai_strategy_subscription_deleted: '策略订阅已删除',
  mt5_account_ownership_acquired: 'MT5 账户归属已确认',
  mt5_account_ownership_transferred: 'MT5 账户归属已转移',
  user_kill_switch_enabled: '账户紧急停止已开启',
  user_kill_switch_disabled: '账户紧急停止已解除',
  global_kill_switch_enabled: '平台紧急停止已开启',
  global_kill_switch_disabled: '平台紧急停止已解除',
  risk_account_halted: '账户风控已暂停',
  risk_account_recovered: '账户风控已自动恢复',
  risk_account_halt_reason_changed: '账户风控暂停原因已变化',
  risk_account_manual_reset: '账户风控已手动重置',
  release_notes_updated: '发布说明已更新',
  notification_campaign_created: '通知活动已创建',
  notification_campaign_cancelled: '通知活动已取消',
  notification_email_retry_requested: '已请求重试通知邮件',
}

const ADMIN_TARGET_LABELS = {
  user:'用户',
  account:'交易账户',
  trading_account:'交易账户',
  strategy:'策略',
  ai_strategy:'AI 策略',
  strategy_subscription:'策略订阅',
  model:'模型',
  ai_model_profile:'AI 模型配置',
  ai_observer_source:'观摩源',
  order:'订单',
  system:'系统',
  system_config:'系统配置',
  referral_rules:'返佣规则',
  platform:'平台',
  risk_restore_request:'风险恢复',
  global_risk_control:'平台风控总闸门',
  global_position_management_control:'全局持仓管理',
  position_protection_job:'持仓保护任务',
  release_notes:'发布说明',
  notification_campaign:'通知活动',
}

const ADMIN_DETAIL_LABELS = {
  auto_reasoning_enabled:'自动推理',
  trade_send_enabled:'交易发送',
  connected:'桥接连接',
  trade_applied:'交易发送已应用',
  trade_error:'交易发送错误',
  previous_plan:'原会员',
  plan:'新会员',
  previous_expires_at:'原到期时间',
  expires_at:'新到期时间',
  password_reset:'重置密码',
  email:'邮箱',
  nickname:'昵称',
  role:'角色',
  plan_source:'会员来源',
  category:'配置分类',
  keys:'配置项',
  detail:'详情',
  reason:'原因',
  request_id:'申请编号',
  title:'标题',
  scope:'范围',
  version:'版本',
  previous_version:'原通知序号',
  new_version:'新通知序号',
  old_version:'原通知序号',
  previous_content_sha256:'原内容校验值',
  new_content_sha256:'新内容校验值',
  old_content_hash:'原内容校验值',
  new_content_hash:'新内容校验值',
  removed_categories:'已移除内容类别',
  sanitized_removed_categories:'净化移除类别',
  legacy_write:'旧版管理端写入',
  active_subscription_count:'有效订阅',
  affected_user_count:'涉及用户',
  enabled:'启用状态',
  previous_value:'原值',
  value:'新值',
  status:'状态',
  account_id:'账户编号',
  trading_account_id:'交易账户编号',
  user_id:'用户编号',
  target_user_id:'目标用户编号',
  strategy_id:'策略编号',
  source_id:'观摩源编号',
  bridge_user_id:'桥接账号编号',
  runtime:'运行状态',
  changes:'变更内容',
  model_name:'模型名称',
  provider:'模型服务商',
  visibility_status:'可见状态',
  is_default:'默认项',
  execution_enabled:'允许执行',
  strategy_scope:'策略范围',
  sync_scope:'同步范围',
  ticket:'订单编号',
  preview_hash:'预览校验值',
  authority:'归属依据',
  previous_user_ids:'原归属用户',
  new_user_id:'新归属用户',
  broker_server:'经纪商服务器',
  login_account:'登录账号',
}

const ADMIN_VALUE_LABELS = {
  platform:'平台',
  user:'普通用户',
  admin:'管理员',
  observer_source:'观摩源',
  free:'免费版',
  plus:'Plus',
  pro:'Pro',
  active:'启用',
  inactive:'停用',
  disabled:'停用',
  success:'成功',
  failed:'失败',
  draft:'草稿',
  archived:'已归档',
  private:'用户私有',
  true:'是',
  false:'否',
}

const ADMIN_SENSITIVE_DETAIL_KEY = /(password(?!_reset)|secret|token|api[_-]?key|private[_-]?key|credential)/i

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
  delivery_recovery_expired: '历史信号已超过安全恢复时限',
  delivery_recovery_untrusted: '历史信号缺少可信恢复证据',
  hold_signal_no_execution: '观望信号无需执行',
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
  duplicate_live_pending: '当前策略在相同价格区域已有系统挂单，本次未重复下单',
  pending_list_unavailable_before_order: '发送前无法刷新交易平台挂单列表，本次未下单',
  execution_clock_context_missing: '缺少本交易账户的可信平台时钟证据，订单未发送',
  execution_clock_identity_mismatch: '交易账户或终端已变化，订单未发送',
  execution_clock_untrusted_source: '交易平台时钟来源不可信，订单未发送',
  execution_clock_stale: '交易平台时钟证据已过期，订单未发送',
  terminal_clock_unverified: '交易平台时钟尚未校准，订单未发送',
  private_portfolio_context_unavailable: '无法获取私有策略所需的持仓与挂单数据',
  portfolio_state_unavailable: '无法读取当前账户的持仓与挂单，本次未执行',
  strategy_reversal_waiting_for_exit: '观摩源旧方向尚未完成退出，本轮不执行反向开仓',
  strategy_reference_portfolio_refresh_unavailable: '无法确认观摩源最新持仓与挂单，本轮停止新开仓',
  opposite_position_exists: '当前账户已有反向持仓，本次不新增仓位',
  existing_position_no_add: '当前账户已有同向持仓，策略未建议加仓',
  reference_position_not_matched: '账户实际持仓与平台参考组合不一致，本次不跟随加仓',
  existing_pending_kept: '当前策略的原挂单仍然有效，继续保留',
  reference_pending_not_matched: '账户中未找到平台策略要管理的对应挂单',
  existing_pending_no_replace: '当前策略已有同向挂单，未收到替换指令',
  pending_cancel_failed: '策略挂单取消失败，本次未继续执行',
  pending_cancelled: '策略旧挂单已取消',
  ai_pending_order_disabled: '平台当前已关闭 AI 挂单执行',
  strategy_policy_pre_submit_blocked: '当前策略执行条件未通过发送前复核',
  subscription_inactive: '策略订阅当前未启用',
  outside_schedule: '当前不在自动推理运行时段内',
  system_execution_exception: '系统执行异常，详细信息已记录',
  lock_lost_before_supersede_cancel: '任务执行权已失效，未继续替换旧挂单',
  lock_lost_before_pending_confirm: '任务执行权已失效，未继续复核挂单',
  lock_lost_before_send: '任务执行权已失效，订单未发送到 MT5',
  'R1.5_RR_TOO_LOW': '盈亏比低于最低要求',
  'R1.5_TP_TIER_UPGRADED': '已改用满足盈亏比要求的更远止盈档位',
  'R1.9_BELOW_MINIMUM_AFTER_RISK': '风险调整后手数低于最小可交易手数',
  'R1_INSTRUMENT_DATA_INCONSISTENT': '交易平台返回的品种风险参数不一致',
  'R4.4_QUOTE_STALE': 'MT5 报价已过期或时间异常',
  'R1.7_PENDING_DEVIATION': '挂单价格偏离当前报价过大',
  'R1.7_PENDING_PRICE_ABNORMAL': '挂单触发价明显异常',
  'R1.7_PENDING_DIRECTION': '挂单方向与当前价格关系不正确',
  'R4.6_EXECUTION_PRICE_DEVIATION': '当前价格超出允许执行区间',
  'PX.3_EXECUTION_PRICE_TOLERANCE': '已按百分比换算 MT5 下单偏差',
  'R1.4_STOP_LOSS_TOO_FAR': '止损距离超过风控上限',
  bridge_upgrade_required_for_incremental_risk: '桥接软件版本过旧，请升级或重启最新版桥接软件',
  risk_snapshot_failed: '无法获取完整的 MT5 风险快照',
  risk_calculation_volume_invalid: '风险计算手数无效',
  preparation_failed: '订单准备未完成',
  bridge_result_uncertain: 'MT5 执行结果待确认',
  broker_rejected: 'MT5 拒绝了订单',
  broker_rejected_order_confirmed: 'MT5 历史已确认订单被拒绝',
  order_not_found_after_complete_reconciliation: '完整核对 MT5 历史后仍未找到订单',
  invalid_volume: 'MT5 下单手数无效',
  'Invalid volume': 'MT5 下单手数无效',
  'Not enough money': 'MT5 账户保证金不足',
  'Trade disabled': 'MT5 账户当前禁止交易',
  'Market closed': 'MT5 当前市场已关闭',
  account_snapshot_failed: '无法获取交易账户快照',
  quote_snapshot_failed: '无法获取当前 MT5 报价',
  symbol_metadata_not_found: '无法获取品种交易参数',
  trading_account_not_found: '未找到当前交易账户',
  trading_account_resolution_failed: '无法确认当前交易账户',
  risk_policy_not_found: '无法读取当前账户风控策略',
  risk_context: '账户风险数据准备',
  risk_snapshot: 'MT5 风险快照',
  risk_policy: '账户风控策略',
  account_snapshot: '交易账户快照',
  quote_snapshot: 'MT5 报价快照',
  instrument: '品种交易参数',
  validation: '订单参数校验',
  stateful_risk: '账户状态风控',
  bridge_payload: 'MT5 下单参数',
  bridge_send: '发送到 MT5',
  portfolio_alignment: '持仓与挂单对齐',
  execution: '订单执行',
  proposed_order: '风险快照试算订单',
  risk_calculation_volume: '风险计算手数',
  policy: '风控策略',
  account: '交易账户',
  symbol: '交易品种',
  order_type: '订单方向',
  volume: '订单手数',
  sl: '止损价格',
  tp: '止盈价格',
  entry_price: '入场价格',
  instrument_metadata: '品种交易参数',
  execution_result: '执行结果',
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
  return '未登记的管理动作'
}

export function auditTargetLabel(value) {
  return ADMIN_TARGET_LABELS[String(value || '').trim()] || '未登记的管理对象'
}

export function adminAuditActionCodesForSearch(value) {
  const keyword = String(value || '').trim().toLocaleLowerCase('zh-CN')
  if (!keyword) return []
  return Object.entries(ACTION_LABELS)
    .filter(([code, label]) => code.toLocaleLowerCase('zh-CN').includes(keyword) || label.toLocaleLowerCase('zh-CN').includes(keyword))
    .map(([code]) => code)
}

function parseAdminAuditDetail(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  const text = String(value ?? '').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { detail:parsed }
  } catch {
    return { detail:text.slice(0, 500) }
  }
}

function adminAuditValue(key, value) {
  if (ADMIN_SENSITIVE_DETAIL_KEY.test(key)) return '已隐藏'
  if (value === null || value === undefined || value === '') return '未设置'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) {
    if (value.some(item => item && typeof item === 'object')) return `共 ${value.length} 项`
    return value.slice(0, 20).map(item => ADMIN_VALUE_LABELS[String(item)] || String(item)).join('、') || '无'
  }
  if (typeof value === 'object') return '已记录结构化变更'
  const text = String(value).slice(0, 500)
  return ADMIN_VALUE_LABELS[text] || text
}

export function adminAuditChangeSummary(detail, limit = 12) {
  const result = []
  const walk = (value, prefix = '') => {
    if (result.length >= limit) return
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      result.push({ field_code:prefix || 'detail', field_label:ADMIN_DETAIL_LABELS[prefix] || '详情', value:adminAuditValue(prefix, value) })
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (result.length >= limit) break
      const fieldCode = prefix ? `${prefix}.${key}` : key
      if (item && typeof item === 'object' && !Array.isArray(item)) walk(item, fieldCode)
      else result.push({
        field_code:fieldCode,
        field_label:ADMIN_DETAIL_LABELS[key] || '未登记字段',
        value:adminAuditValue(fieldCode, item),
      })
    }
  }
  walk(parseAdminAuditDetail(detail))
  return result.length ? result : [{ field_code:'detail', field_label:'详情', value:'已记录操作，无附加参数' }]
}

function adminAuditContainsSensitiveDetail(detail) {
  const visit = value => {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(visit)
    return Object.entries(value).some(([key, item]) => ADMIN_SENSITIVE_DETAIL_KEY.test(key) || visit(item))
  }
  return visit(parseAdminAuditDetail(detail))
}

export function localizeAdminAuditEvent(row = {}) {
  const actionCode = String(row.action || '').trim() || 'unknown'
  const targetTypeCode = String(row.target_type || '').trim() || 'unknown'
  const actionLabel = auditActionLabel(actionCode)
  const targetTypeLabel = auditTargetLabel(targetTypeCode)
  const targetLabel = `${targetTypeLabel}${row.target_id ? ` #${row.target_id}` : ''}`
  const details = adminAuditChangeSummary(row.detail)
  return {
    ...row,
    detail:undefined,
    raw_action:actionCode,
    action_code:actionCode,
    action_label:actionLabel,
    target_type_code:targetTypeCode,
    target_type_label:targetTypeLabel,
    target_label:targetLabel,
    status_code:'info',
    status_label:auditStatusLabel('info'),
    summary:`${actionLabel}：${details.slice(0, 2).map(item => `${item.field_label}${item.value}`).join('，')}`,
    details,
    change_summary:details,
    sensitive_fields_redacted:adminAuditContainsSensitiveDetail(row.detail),
  }
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
  if (rawCode === 'R1.5_RR_TOO_LOW') return `${base}：当前 ${displayNumber(details.rr ?? details.current)}，最低要求 ${displayNumber(details.minimum ?? details.limit)}`
  if (rawCode === 'R1.9_AI_VOLUME_OUT_OF_RANGE') return `${base}：执行上限 ${displayNumber(details.volume)} 手，允许范围 ${displayNumber(details.minimum)}～${displayNumber(details.maximum)} 手，步进 ${displayNumber(details.step)} 手`
  if (rawCode === 'R1.9_BELOW_MINIMUM_AFTER_RISK') {
    if (Number.isFinite(Number(details.theoretical_volume)) && Number.isFinite(Number(details.risk_cap)) && Number.isFinite(Number(details.minimum_lot_risk))) {
      const rounded = details.rounded_volume_candidate ?? details.volume
      const guard = details.rounding_guard_applied ? '，向上舍入超过风险预算后已安全回退' : ''
      return `${base}：理论手数 ${displayNumber(details.theoretical_volume, 4)}，按 ${displayNumber(details.rounding_step ?? details.step)} 手步进四舍五入候选为 ${displayNumber(rounded)} 手${guard}；最终 ${displayNumber(details.approved_volume ?? details.volume)} 手，本次风险预算 ${displayNumber(details.risk_cap, 2)}，最小 ${displayNumber(details.minimum)} 手预计止损亏损 ${displayNumber(details.minimum_lot_risk, 2)}（均为账户货币），因此未执行`
    }
    return `${base}：风险计算后为 ${displayNumber(details.volume)} 手，最低可交易 ${displayNumber(details.minimum)} 手`
  }
  if (rawCode === 'R1_INSTRUMENT_DATA_INCONSISTENT') {
    return `${base}：tick size ${displayNumber(details.tick_size, 8)}，tick value ${displayNumber(details.tick_value, 8)}，来源 ${details.tick_size_source || '未确认'}；已为安全起见阻止下单`
  }
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

// Only a compact, audited subset of execution evidence may cross the
// realtime boundary.  Risk policy/account snapshots stay server-side.
const SAFE_EXECUTION_DETAIL_KEYS = new Set([
  'risk_decision_id', 'current', 'limit', 'minimum', 'maximum', 'step', 'volume',
  'theoretical_volume', 'capped_volume_before_rounding', 'rounded_volume_candidate',
  'approved_volume', 'rounding_mode', 'rounding_step', 'rounding_guard_applied',
  'rounded_risk_amount', 'risk_cap', 'minimum_lot_risk', 'risk_calculation_volume', 'trigger_price',
  'stop_limit_price', 'current_price', 'entry_price', 'quote_age_seconds',
  'maximum_seconds', 'spread_points', 'remaining_seconds', 'count', 'remaining',
  'allowed_min', 'allowed_max', 'maximum_pct', 'drawdown_pct', 'limit_pct',
  'daily_loss_pct', 'daily_loss_limit_pct', 'loss_pct', 'rr', 'minimum_rr', 'deviation',
  'stop_loss', 'take_profit',
  'minimum_seconds', 'until', 'remaining_same_direction', 'lookback_seconds',
  'ticket', 'tickets', 'retcode', 'stage', 'field', 'reason', 'tick_size', 'tick_value',
  'point', 'contract_size', 'tick_size_source', 'instrument_validation_status',
  'validation_reasons', 'instrument_validation_reasons',
  'pending_action_reason', 'pending_action', 'management_group_ids', 'model_task_status',
])

const PREPARATION_STAGES = Object.freeze({
  account_snapshot: '交易账户快照', quote_snapshot: 'MT5 报价快照', risk_policy: '账户风控策略',
  risk_context: '账户风险数据准备', risk_snapshot: 'MT5 风险快照', instrument: '品种交易参数',
  validation: '订单参数校验', stateful_risk: '账户状态风控', risk_reservation: '风险额度预留',
  bridge_payload: 'MT5 下单参数', before_bridge_send: '发送前安全检查',
  bridge_send: '发送到 MT5',
  portfolio_alignment: '持仓与挂单对齐', execution: '订单执行',
})

const PREPARATION_FIELDS = Object.freeze({
  account: '交易账户', quote: '当前报价', policy: '风控策略', risk_snapshot: '风险快照',
  proposed_order: '风险快照试算订单', risk_calculation_volume: '风险计算手数',
  instrument: '品种交易参数', symbol: '交易品种', order_type: '订单方向', volume: '订单手数',
  sl: '止损价格', tp: '止盈价格', bridge_payload: 'MT5 下单参数', execution: '执行流程',
})

export function localizeExecutionStage(value) {
  const code = String(value || '').trim()
  const localized = auditValueLabel(code)
  return PREPARATION_STAGES[code] || (localized !== code ? localized : '交易准备')
}

export function localizeExecutionField(value) {
  const code = String(value || '').trim()
  const localized = auditValueLabel(code)
  return PREPARATION_FIELDS[code] || (localized !== code ? localized : '执行参数')
}

function safeExecutionScalar(value) {
  if (value == null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 120)
  if (typeof value === 'boolean') return value
  return null
}

export function sanitizeExecutionDetails(details = {}) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {}
  const safe = {}
  for (const [key, value] of Object.entries(details)) {
    if (key === 'rules') {
      safe.rules = (Array.isArray(value) ? value : []).slice(0, 16).map(rule => {
        const code = String(rule?.code || '').trim().slice(0, 96)
        if (!code) return null
        const ruleDetails = sanitizeExecutionDetails(rule?.details || {})
        const current = ruleDetails.current ?? ruleDetails.volume ?? ruleDetails.daily_loss_pct ?? ruleDetails.count ?? null
        const limit = ruleDetails.limit ?? ruleDetails.maximum ?? ruleDetails.minimum ?? ruleDetails.limit_pct ?? null
        return { code, outcome:String(rule?.outcome || 'reject').slice(0, 24), details:ruleDetails,
          label:auditValueLabel(code) === code && /^(?:R\d|PX\.)/i.test(code) ? '风控条件未满足' : auditValueLabel(code),
          ...(current == null ? {} : { current }), ...(limit == null ? {} : { limit }) }
      }).filter(Boolean)
      continue
    }
    if (!SAFE_EXECUTION_DETAIL_KEYS.has(key)) continue
    if (Array.isArray(value)) {
      if (['tickets', 'management_group_ids'].includes(key)) {
        safe[key] = value.slice(0, 20).map(safeExecutionScalar).filter(item => item != null)
      }
      continue
    }
    const scalar = safeExecutionScalar(value)
    if (scalar !== null) safe[key] = scalar
  }
  return safe
}

export function localizeBrokerRejection(reason, retcode = null) {
  const known = auditValueLabel(reason)
  if (known !== String(reason || '').trim()) return known
  const code = retcode === null || retcode === undefined || retcode === '' ? null : Number(retcode)
  return Number.isInteger(code) ? `MT5 拒绝了订单（返回码 ${code}）` : 'MT5 拒绝了订单'
}

export function localizeExecutionReason(reason, details = {}, classification = '') {
  const code = String(reason || '').trim()
  if (classification === 'risk_rejection') {
    const rule = (details.rules || []).find(item => item?.outcome === 'reject')
    return rule ? formatRiskReason(rule.code, rule.details || {}) : formatRiskReason(code, details)
  }
  if (classification === 'broker_rejection') return localizeBrokerRejection(code, details.retcode)
  if (classification === 'preparation_failure') {
    const stage = localizeExecutionStage(details.stage)
    const field = details.field ? `（${localizeExecutionField(details.field)}）` : ''
    const localized = auditValueLabel(code)
    const reasonText = localized && localized !== code ? localized : '系统执行条件未满足'
    return `订单准备未完成：${stage}${field}。${reasonText}`
  }
  return formatRiskReason(code, details)
}

const KNOWN_BROKER_REASONS = new Set([
  'Invalid price', 'Invalid stops', 'Invalid volume', 'Not enough money',
  'Trade disabled', 'Market closed', 'Unsupported filling mode',
])

function executionReasonCode(reason, classification, fallback) {
  const raw = String(reason || '').trim()
  if (!raw) return fallback
  if (/^(?:R\d|PX\.)[A-Z0-9._-]+$/i.test(raw) || /^[a-z][a-z0-9_.:-]{1,96}$/i.test(raw)) return raw
  if (KNOWN_BROKER_REASONS.has(raw)) return raw
  return classification === 'broker_rejection' ? 'broker_rejected' : fallback
}

function inferExecutionClassification(status, reason, details, retcode) {
  const code = String(reason || '').trim()
  if (status === 'rejected' && (Array.isArray(details?.rules) || /^(?:R\d|PX\.)/i.test(code))) return 'risk_rejection'
  if (status === 'rejected' && retcode !== null && retcode !== undefined && retcode !== ''
    && Number.isInteger(Number(retcode))) return 'broker_rejection'
  if (status === 'skipped') return 'execution_skipped'
  if (status === 'success') return 'execution_success'
  if (status === 'uncertain') return 'execution_uncertain'
  return 'preparation_failure'
}

export function buildSafeExecutionOutcome({
  status = 'failed', classification = '', reason = '', details = {}, stage = '', field = '', retcode = null,
} = {}) {
  const normalizedClassification = classification || inferExecutionClassification(
    status, reason, details, retcode ?? details?.retcode ?? details?.broker_retcode)
  const normalizedStatus = normalizedClassification === 'preparation_failure' && status === 'rejected' ? 'failed' : status
  const fallback = normalizedClassification === 'broker_rejection' ? 'broker_rejected'
    : normalizedClassification === 'preparation_failure' ? 'preparation_failed'
      : normalizedClassification === 'execution_uncertain' ? 'bridge_result_uncertain'
        : normalizedClassification === 'execution_success' ? 'success' : 'execution_skipped'
  const reasonCode = executionReasonCode(reason, normalizedClassification, fallback)
  const safeDetails = sanitizeExecutionDetails({ ...details,
    ...(stage ? { stage } : {}), ...(field ? { field } : {}) })
  const rawRetcode = retcode ?? details?.retcode ?? details?.broker_retcode
  const numericRetcode = rawRetcode === null || rawRetcode === undefined || rawRetcode === '' ? null : Number(rawRetcode)
  if (Number.isInteger(numericRetcode)) safeDetails.retcode = numericRetcode
  return {
    status: normalizedStatus,
    classification: normalizedClassification,
    reason: reasonCode,
    reason_code: reasonCode,
    message: localizeExecutionReason(reasonCode, safeDetails, normalizedClassification),
    details: safeDetails,
    ...(stage ? { stage } : {}),
    ...(field ? { field } : {}),
    ...(Number.isInteger(numericRetcode) ? { retcode: numericRetcode } : {}),
  }
}

export function buildSafeExecutionEvent(outcome = {}, extra = {}) {
  return {
    ...extra,
    status: outcome.status,
    classification: outcome.classification,
    reason: outcome.message || localizeExecutionReason(outcome.reason, outcome.details, outcome.classification),
    reason_code: outcome.reason_code || outcome.reason,
    details: sanitizeExecutionDetails(outcome.details),
    ...(outcome.stage ? { stage: outcome.stage } : {}),
    ...(outcome.field ? { field: outcome.field } : {}),
    ...(outcome.retcode != null ? { retcode: outcome.retcode } : {}),
  }
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
