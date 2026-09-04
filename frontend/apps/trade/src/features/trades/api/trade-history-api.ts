import { createApiClient } from '@aurum/api-client'

const client = createApiClient()

export const tradeHistoryApi = {
  getContext: () => client.getTradingContext(),
  listAccounts: () => client.listTradingAccounts(),
  list: (filter: Parameters<typeof client.listTradeHistory>[0]) => client.listTradeHistory(filter),
  detail: (recordId: string) => client.getTradeRecord(recordId),
}
