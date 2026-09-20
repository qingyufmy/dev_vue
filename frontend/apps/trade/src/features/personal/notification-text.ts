// Display-only translations: preserve the stored source and all prices and identifiers.
const terms: Record<string, string> = {
  reversal_watch: '反转观察', up_reversal_watch: '向上反转观察', down_reversal_watch: '向下反转观察',
  market_order: '市价单', pending_order: '挂单', modify_position: '修改持仓保护价', close_position: '平仓',
  cancel_order: '撤销挂单', modify_order: '修改挂单', manage: '持仓管理', hold: '保持不变',
  pendingOrders: '挂单', local_bias: '局部方向', entry_candidates: '入场候选',
}
export function notificationText(value: string): string {
  return value.replace(/[A-Za-z_][A-Za-z_0-9]*/g, token => terms[token] ?? token)
}
