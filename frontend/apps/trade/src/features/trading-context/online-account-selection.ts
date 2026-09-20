import type { TradingAccount } from '@aurum/contracts'

export function preferredOnlineAccount(accounts: readonly Pick<TradingAccount, 'id' | 'bridgeState'>[], currentId: string | null) {
  const online = accounts.filter(account => account.bridgeState === 'online')
  return online.find(account => account.id === currentId)?.id ?? online[0]?.id ?? null
}
