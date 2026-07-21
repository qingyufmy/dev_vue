import { BaseChainAdapter } from './base.js'
import { deriveAddress as walletDeriveAddress, getCryptoWalletApiKey } from '../wallet.js'

class TronAdapter extends BaseChainAdapter {
  name = 'TRON'
  chainId = 'tron'

  _deriveRaw(index) {
    const address = walletDeriveAddress('TRON', index)
    return { address, publicKey: '' }
  }

  getApiBaseUrl() {
    return 'https://api.trongrid.io'
  }

  getRequiredConfirmations() {
    return 19
  }

  async getApiHeaders() {
    const apiKey = await getCryptoWalletApiKey('TRON')
    return {
      'TRON-PRO-API-KEY': apiKey,
      'Accept': 'application/json'
    }
  }

  async getTransaction(txHash) {
    try {
      const url = `${this.getApiBaseUrl()}/walletsolidity/gettransactioninfobyid`
      const headers = await this.getApiHeaders()
      const resp = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: txHash }),
      })
      if (!resp.ok) return null
      const data = await resp.json()
      if (!data.id || !data.blockNumber) return null
      if (data.receipt?.result && data.receipt.result !== 'SUCCESS') return null

      return {
        hash: txHash,
        blockNumber: data.blockNumber,
        confirmations: this.getRequiredConfirmations(),
        status: 'success',
      }
    } catch {
      return null
    }
  }

  async getConfirmations(txHash) {
    const tx = await this.getTransaction(txHash)
    return tx ? this.getRequiredConfirmations() : 0
  }

  buildTransferEventFilter(watchedAddresses) {
    return {
      chain: 'TRON',
      topic: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      addresses: watchedAddresses,
    }
  }
}

export const tronAdapter = new TronAdapter()
