export type WalletChain = 'TRON' | 'ETH' | 'BSC' | 'SOL'
export interface WalletAddress {
  id: string
  chain: WalletChain
  addressIndex: string
  address: string
  createdAtUtc: string | null
  revision: string
  custody: { status: 'unverified' } | { status: 'verified'; reference: string; evidenceSha256: string; verifiedAtUtc: string }
}
export interface WalletAddressReader {
  list(input: { chain: WalletChain; afterId?: string; limit?: number }): Promise<{ items: WalletAddress[]; nextAfterId: string | null }>
}
