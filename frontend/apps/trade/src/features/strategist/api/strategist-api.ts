import { createApiClient } from '@aurum/api-client'

const client = createApiClient()

export const strategistApi = {
  listStrategies: client.listStrategies,
  getStrategy: client.getStrategy,
  compileStrategy: client.compileStrategy,
  createStrategy: client.createStrategy,
  updateStrategyMetadata: client.updateStrategyMetadata,
  createStrategyVersion: client.createStrategyVersion,
  publishStrategyVersion: client.publishStrategyVersion,
  retireStrategy: client.retireStrategy,
  listSubscriptions: client.listStrategySubscriptions,
  createSubscription: client.createStrategySubscription,
  updateSubscription: client.updateStrategySubscription,
  listAccounts: client.listTradingAccounts,
  getWorkspace: client.getTradingWorkspace,
}
