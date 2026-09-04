import { createApiClient } from '@aurum/api-client'

const client = createApiClient()

export const riskApi = {
  getContext: client.getTradingContext,
  listAccounts: client.listTradingAccounts,
  selectAccount: client.selectTradingAccount,
  getPolicy: client.getRiskPolicy,
  replacePolicy: client.replaceRiskPolicy,
  getSummary: client.getRiskSummary,
  getManualRelease: client.getManualRiskRelease,
  createManualRelease: client.createManualRiskRelease,
  listDecisions: client.listRiskDecisions,
  getDecision: client.getRiskDecision,
}
