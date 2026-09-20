export const roles = [
  ['api-v4', 3010, '接口'], ['browser-realtime', 3011, '网页实时推送'],
  ['bridge-gateway', 3012, '桥接网关'], ['worker-public-market', 3029, '公共行情'],
  ['outbox-dispatcher', 3020, '消息分发'], ['scheduler-trade-history', 3027, '历史同步'],
  ['worker-risk-summary', 3030, '风控汇总'], ['worker-analysis', 3023, 'AI 分析'],
  ['worker-trader', 3024, 'AI 交易评估'], ['scheduler-analysis', 3022, '分析调度'],
  ['auth-web', 4176, '登录页面'], ['trade-web', 4174, '交易页面'],
  ['worker-risk', 3025, '逐笔风控'], ['worker-execution', 3021, '订单执行', true],
  ['scheduler-execution', 3028, '执行恢复调度', true], ['worker-review', 3026, '复盘', true],
].map(([id, port, label, full = false]) => ({ id, port, label, full, web: id.endsWith('-web') }))

export const defaultProfile = 'full'

export function selectRoles(profile = defaultProfile) {
  if (!['core', 'full'].includes(profile)) throw new Error('profile must be core or full')
  return roles.filter(role => profile === 'full' || !role.full)
}

export function restartAllowed(exits, now = Date.now()) {
  return exits.filter(at => now - at < 300_000).length < 3
}
