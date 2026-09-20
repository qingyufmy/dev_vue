import type { AuditEventDetail, AuditStatus } from '@aurum/contracts'

type Node = AuditEventDetail['trace'][number]
const actionLabels: Record<string, string> = { market_order: '市价下单', pending_order: '挂单', modify_position: '修改持仓', close_position: '平仓', modify_order: '修改挂单', cancel_order: '撤单' }
export function executionActionGroups(trace: Node[]) {
  const groups = new Map<string, Node[]>()
  for (const node of trace) {
    if (!node.intentId) continue
    const nodes = groups.get(node.intentId) ?? []
    nodes.push(node)
    groups.set(node.intentId, nodes)
  }
  return [...groups].map(([id, nodes]) => {
    const outcomes = nodes.filter(node => node.stage === 'terminal')
    const intent = nodes.find(node => node.stage === 'intent')
    let status: AuditStatus = 'running'
    let label = '处理中'
    if (outcomes.length) {
      if (outcomes.some(node => node.status === 'uncertain')) { status = 'uncertain'; label = '待核实' }
      else if (outcomes.every(node => node.status === 'succeeded')) { status = 'succeeded'; label = '已完成' }
      else if (outcomes.some(node => node.status === 'succeeded')) { status = 'uncertain'; label = '部分完成，待核实' }
      else { status = outcomes[0]!.status; label = status === 'rejected' ? '未获通过' : '执行失败' }
    } else if (intent && ['failed', 'rejected', 'cancelled', 'uncertain', 'queued'].includes(intent.status)) {
      status = intent.status
      label = { failed: '执行失败', rejected: '未获通过', cancelled: '已取消', uncertain: '待核实', queued: '等待处理' }[status as 'failed' | 'rejected' | 'cancelled' | 'uncertain' | 'queued']
    } else if (nodes.some(node => node.status === 'succeeded')) { label = '等待终端回执' }
    const labels: Record<string, string> = { symbol: '品种', ticket: '订单号', side: '方向', volume: '手数', price: '委托价格', stop_loss: '止损价', take_profit: '止盈价' }
    const parameters = Object.entries(intent?.parameters ?? {}).filter(([key, value]) => key in labels && value !== '').map(([key, value]) => ({ key, label: labels[key], value: key === 'side' ? ({ buy: '买入', sell: '卖出' }[value] ?? '未识别') : value }))
    return { id, nodes, status, label, parameters, title: actionLabels[intent?.actionKind ?? nodes[0]?.actionKind ?? ''] ?? '交易动作' }
  })
}
