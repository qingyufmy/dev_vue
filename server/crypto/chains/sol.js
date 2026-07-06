import { BaseChainAdapter } from './base.js'
import { deriveAddress as walletDeriveAddress, getCryptoWalletApiKey } from '../wallet.js'

class SolAdapter extends BaseChainAdapter {
  name = 'SOL'
  chainId = 'sol'

  _deriveRaw(index) {
    const address = walletDeriveAddress('SOL', index)
    return { address, publicKey: '' }
  }

  getApiBaseUrl() {
    return 'https://api.mainnet-beta.solana.com'
  }

  getRequiredConfirmations() {
    return 32
  }

  async getRpcUrl() {
    const rpcUrl = await getCryptoWalletApiKey('SOL')
    return rpcUrl || this.getApiBaseUrl()
  }

  async getTransaction(txHash) {
    try {
      const baseUrl = await this.getRpcUrl()
      const resp = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [txHash, { encoding: 'jsonParsed' }],
        }),
      })
      if (!resp.ok) return null
      const data = await resp.json()
      const result = data.result
      if (!result || !result.transaction) return null

      const meta = result.meta || {}
      if (meta.err) return null

      const accounts = result.transaction.message?.accountKeys || []
      const from = accounts[0] || ''
      const to = accounts[1] || ''

      const preBal = meta.preBalances?.[0] || 0
      const postBal = meta.postBalances?.[0] || 0
      const value = Math.max(0, (postBal - preBal) / 1e6)

      return {
        hash: txHash,
        from,
        to,
        value,
        blockNumber: result.slot || 0,
        confirmations: 0,
        status: 'success',
      }
    } catch {
      return null
    }
  }

  async getConfirmations(txHash) {
    try {
      const tx = await this.getTransaction(txHash)
      if (!tx || !tx.blockNumber) return 0

      const baseUrl = await this.getRpcUrl()
      const slotResp = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSlot',
        }),
      })
      if (!slotResp.ok) return 0
      const slotData = await slotResp.json()
      const currentSlot = slotData.result || 0

      const txSlotResp = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [txHash, { encoding: 'jsonParsed' }],
        }),
      })
      if (!txSlotResp.ok) return 0
      const txSlotData = await txSlotResp.json()
      const txSlot = txSlotData.result?.slot || 0

      return Math.max(0, currentSlot - txSlot)
    } catch {
      return 0
    }
  }

  buildTransferEventFilter(watchedAddresses) {
    return {
      chain: 'SOL',
      topic: 'Transfer',
      addresses: watchedAddresses,
    }
  }
}

export const solAdapter = new SolAdapter()
