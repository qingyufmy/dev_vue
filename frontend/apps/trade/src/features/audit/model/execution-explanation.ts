const reasons: Record<string, string> = {
  RISK_TRADE_SEND_DISABLED: '历史发送许可限制曾阻止该指令；当前版本已取消此独立开关。',
  execution_dispatch_policy_halted: '账户或平台已暂停交易，指令未放行。',
  execution_order_volume_exceeded: '交易手数超过账户允许范围。',
  execution_subscription_changed: '订阅已关闭或设置已变化，本次指令不再继续。',
  execution_strategy_config_changed: '交易策略已更新，需要重新评估。',
  execution_schedule_closed: '当前不在订阅允许的交易时段。',
  bridge_command_deadline_expired: '指令已超过有效时间，不再发送。',
  trader_preferences_changed: '交易设置已变化，需要重新评估。',
  bridge_terminal_session_not_found: '终端尚未连接，请检查量见智桥。',
}
export function executionExplanation(code: string | null | undefined, status: string) {
  if (code && reasons[code]) return reasons[code]
  return ({ queued: '指令已登记，等待处理。', accepted: '指令已受理，等待处理。', running: '正在处理，请等待结果。', succeeded: '此步骤已完成，请查看终端结果确认成交。', rejected: '此步骤未通过检查，未继续执行。', failed: '此步骤处理失败，请核对连接与交易设置。', uncertain: '指令可能已送达，结果尚待核实，请勿重复提交。', partially_succeeded: '部分操作已完成，请逐项核对结果。', cancelled: '此操作已取消。', expired: '此操作已过有效期。', info: '处理信息已记录。' } as Record<string, string>)[status] ?? '请查看执行过程了解处理结果。'
}
