import { createApiClient } from '@aurum/api-client'
import type { AnalysisJobCreate } from '@aurum/contracts'

const client = createApiClient()

export const analystApi = {
  listStrategies: () => client.listStrategies('analysis'),
  listAnalyses: (pageSize = 50) => client.listMarketAnalyses(pageSize),
  getAnalysis: (analysisId: string) => client.getMarketAnalysis(analysisId),
  createManualAnalysis: (csrfToken: string, input: AnalysisJobCreate, idempotencyKey: string) => (
    client.createManualAnalysis(csrfToken, input, idempotencyKey)
  ),
}
