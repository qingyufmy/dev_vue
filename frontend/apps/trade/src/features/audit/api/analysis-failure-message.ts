import { auditApi } from './audit-api'

export async function readAnalysisFailureMessage(id: string) {
  const messages: Record<string, string> = {
    daily_token_limit: '当日模型用量已达上限，请等待额度恢复后再分析。',
    manual_analysis_cooldown: '手动分析仍在冷却中，请稍后再试。',
    strategy_not_active: '分析策略当前不可用，请检查策略发布状态。',
  }
  try {
    const { data } = await auditApi.detail('analysis_run', id)
    return messages[data.event.reasonCode ?? ''] ?? '本次分析未完成，请检查模型与策略配置。'
  } catch { return '本次分析未完成，暂时无法读取具体原因。' }
}
