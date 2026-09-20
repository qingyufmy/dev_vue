import { createApiClient } from '@aurum/api-client'

const client = createApiClient()

export const riskApi = {
  getContext: client.getTradingContext,
  listAccounts: client.listTradingAccounts,
  getPolicy: client.getRiskPolicy,
  replacePolicy: client.replaceRiskPolicy,
  getPolicyReceipt: client.getRiskPolicyReceipt,
  getSummary: client.getRiskSummary,
  getManualRelease: client.getManualRiskRelease,
  getManualReleaseReceipt: client.getManualRiskReleaseReceipt,
  createManualRelease: client.createManualRiskRelease,
  listDecisions: client.listRiskDecisions,
  getDecision: client.getRiskDecision,
}
