import { createApiClient } from '@aurum/api-client'

const client = createApiClient()

export const traderApi = {
  getContext: client.getTradingContext,
  listAccounts: client.listTradingAccounts,
  listObservers: client.listObserverChannels,
  getWorkspace: client.getTradingWorkspace,
  selectAccount: client.selectTradingAccount,
  listStrategies: () => client.listStrategies('trader'),
  listDecisions: client.listTradeDecisions,
  getDecision: client.getTradeDecision,
}
