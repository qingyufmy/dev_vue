/** Read-only routing evidence. A lease alone never grants ownership or trading permission. */
export interface AccountLiveRoute {
  userId: number
  accountId: string
  platform: 'mt4' | 'mt5'
  brokerServer: string
  login: string
  terminalProfileId: string
  terminalInstanceId: string
  connectionId: string
  connectionEpoch: number
}

export interface AccountLiveRouteReader {
  current(accountId: string): Promise<AccountLiveRoute | null>
}
