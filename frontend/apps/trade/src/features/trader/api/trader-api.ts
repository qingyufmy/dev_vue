import { createApiClient } from '@aurum/api-client'

const client = createApiClient()

export const traderApi = {
  getContext: client.getTradingContext,
  listAccounts: client.listTradingAccounts,
  listObservers: client.listObserverChannels,
  getWorkspace: client.getTradingWorkspace,
  listStrategies: () => client.listStrategies('trader'),
  listDecisions: client.listTradeDecisions,
  getDecision: client.getTradeDecision,
  getCommandContext: client.getExecutionCommandContext,
  createCommand: client.createExecutionCommand,
  previewDistribution: client.previewExecutionDistribution,
  createDistribution: client.createExecutionDistribution,
  getDistribution: client.getExecutionDistribution,
  createDistributionClose: client.createDistributionCloseCommand,
  getOperation: client.getOperation,
}
