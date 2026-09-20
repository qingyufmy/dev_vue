import { expect, it, vi } from 'vitest'
import { readAnalysisFailureMessage } from '../src/features/audit/api/analysis-failure-message'
const detail = vi.hoisted(() => vi.fn())
vi.mock('../src/features/audit/api/audit-api', () => ({ auditApi: { detail } }))
it('explains daily limits and hides unknown internal failures', async () => {
  detail.mockResolvedValueOnce({ data: { event: { reasonCode: 'daily_token_limit' } } })
  expect(await readAnalysisFailureMessage('run')).toContain('当日模型用量已达上限')
  expect(detail).toHaveBeenCalledWith('analysis_run', 'run')
  detail.mockResolvedValueOnce({ data: { event: { reasonCode: 'internal_sql_error' } } })
  expect(await readAnalysisFailureMessage('run')).not.toContain('internal_sql_error')
  detail.mockRejectedValueOnce(new Error('network'))
  expect(await readAnalysisFailureMessage('run')).toContain('暂时无法读取')
})
