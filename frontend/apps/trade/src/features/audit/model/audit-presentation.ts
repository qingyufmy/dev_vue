import type { AuditActor, AuditCategory, AuditEvent as AuditEventContract, AuditEventDetail, AuditEventPageResponse, AuditSourceKind, AuditStatus, TradingAccount } from '@aurum/contracts'

export type AuditEvent = AuditEventContract
export type AuditSummary = AuditEventPageResponse['data']['summary']
export type AuditDetail = AuditEventDetail
export type AuditTraceNode = AuditDetail['trace'][number]
export type AuditEvidenceItem = AuditDetail['evidence'][number]
export type AuditLink = AuditDetail['links'][number]

export type AuditFilters = {
  category: '' | AuditCategory
  status: '' | AuditStatus
  actor: '' | AuditActor
  from: string
  to: string
  query: string
}

export const emptyAuditFilters = (): AuditFilters => ({
  category: '',
  status: '',
  actor: '',
  from: '',
  to: '',
  query: '',
})

export const emptyAuditSummary = (): AuditSummary => ({
  total: 0,
  succeeded: 0,
  rejected: 0,
  failed: 0,
  uncertain: 0,
  active: 0,
})

const sourceLabels: Record<string, string> = {
  analysis_run: '行情分析',
  trader_run: '交易员判断',
  risk_decision: '风控评审',
  operation: '系统操作',
  bridge_command: '智桥指令',
  risk_policy_change: '风控规则',
  risk_manual_release: '手动解限',
  terminal_trade: '终端成交',
}

const sourceKindValues: readonly AuditSourceKind[] = [
  'analysis_run', 'trader_run', 'risk_decision', 'operation', 'bridge_command',
  'risk_policy_change', 'risk_manual_release', 'terminal_trade',
]

const categoryLabels: Record<string, string> = {
  analysis: '行情分析',
  trading: '交易决策',
  risk: '风控',
  execution: '执行链路',
  terminal: '终端事实',
  configuration: '配置变更',
}

const actorLabels: Record<string, string> = {
  ai: 'AI',
  user: '用户',
  system: '系统',
  bridge: '量见智桥',
}

const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '处理中',
  succeeded: '已完成',
  rejected: '已拒绝',
  failed: '失败',
  uncertain: '待核实',
  cancelled: '已取消',
  info: '信息',
}

const stageLabels: Record<string, string> = {
  analysis: '行情分析',
  trader: 'AI 交易员',
  risk: '服务端风控',
  operation: '操作记录',
  intent: '执行意图',
  bridge: '智桥回执',
  terminal: '终端事实',
}

export function sourceLabel(value: string) {
  return sourceLabels[value] ?? '来源待核实'
}

export function isAuditSourceKind(value: string): value is AuditSourceKind {
  return sourceKindValues.includes(value as AuditSourceKind)
}

export function categoryLabel(value: string) {
  return categoryLabels[value] ?? '分类待核实'
}

export function actorLabel(value: string) {
  return actorLabels[value] ?? '主体待核实'
}

export function statusLabel(value: string) {
  return statusLabels[value] ?? '状态待核实'
}

export function stageLabel(value: string) {
  return stageLabels[value] ?? '链路节点'
}

export function statusVariant(value: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (value === 'succeeded' || value === 'info') return 'default'
  if (value === 'rejected' || value === 'failed') return 'destructive'
  if (value === 'uncertain') return 'outline'
  return 'secondary'
}

export function accountLabel(account: TradingAccount | null | undefined) {
  if (!account) return '账户待核实'
  return `${account.platform.toUpperCase()} · ${account.login} · ${account.server}`
}

export function formatAuditTimestamp(value: string | null | undefined, offsetMinutes: number | null | undefined = null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  const offset = offsetMinutes ?? 0
  const shifted = new Date(date.getTime() + offset * 60_000)
  const text = shifted.toISOString().slice(0, 19).replace('T', ' ')
  if (offsetMinutes === null || offsetMinutes === undefined) return `${text} UTC`
  const sign = offset >= 0 ? '+' : '-'
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0')
  return `${text} UTC${sign}${hours}:${minutes}`
}

export function formatCount(value: number | null | undefined) {
  return Number(value ?? 0).toLocaleString('zh-CN')
}

export function auditLinkTarget(link: AuditLink) {
  if (link.kind === 'analysis') return { path: '/analyst', query: { analysis_id: link.id } }
  if (link.kind === 'trader') return { path: '/trader', query: { decision_id: link.id } }
  if (link.kind === 'risk') return { path: '/risk', query: { decision_id: link.id } }
  if (link.kind === 'trade') return { path: '/trades', query: { record_id: link.id } }
  return { path: '/audit', query: { source_kind: 'operation', source_id: link.id } }
}
