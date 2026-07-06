import { BaseChainAdapter } from './base.js'
import { deriveAddress as walletDeriveAddress } from '../wallet.js'

class BscAdapter extends BaseChainAdapter {
  name = 'BSC'
  chainId = 'bsc'

  _deriveRaw(index) {
    const address = walletDeriveAddress('BSC', index)
    return { address, publicKey: '' }
  }

  getApiBaseUrl() {
    return 'https://api.bscscan.com'
  }

  getRequiredConfirmations() {
    return 15
  }

  async getTransaction(txHash) {
    try {
      const apiKey = process.env.BSCSCAN_API_KEY || ''
      const url = `${this.getApiBaseUrl()}/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${apiKey}`
      const resp = await fetch(url)
      if (!resp.ok) return null
      const data = await resp.json()

      if (!data.result || data.result.hash === undefined) {
        const url2 = `${this.getApiBaseUrl()}/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${apiKey}`
        const resp2 = await fetch(url2)
        if (!resp2.ok) return null
        const data2 = await resp2.json()
        if (!data2.result) return null
        const r = data2.result
        return {
          hash: r.transactionHash || txHash,
          from: r.from || '',
          to: r.to || '',
          value: 0,
          blockNumber: parseInt(r.blockNumber || '0', 16),
          confirmations: 0,
          status: r.status === '0x1' ? 'success' : 'failed',
        }
      }

      const tx = data.result
      return {
        hash: tx.hash || txHash,
        from: tx.from || '',
        to: tx.to || '',
        value: parseInt(tx.value || '0', 16),
        blockNumber: parseInt(tx.blockNumber || '0', 16),
        confirmations: 0,
        status: 'pending',
      }
    } catch {
      return null
    }
  }

  async getConfirmations(txHash) {
    try {
      const tx = await this.getTransaction(txHash)
      if (!tx || !tx.blockNumber) return 0

      const apiKey = process.env.BSCSCAN_API_KEY || ''
      const url = `${this.getApiBaseUrl()}/api?module=proxy&action=eth_blockNumber&apikey=${apiKey}`
      const resp = await fetch(url)
      if (!resp.ok) return 0
      const data = await resp.json()
      const currentBlock = parseInt(data.result || '0', 16)
      return Math.max(0, currentBlock - tx.blockNumber)
    } catch {
      return 0
    }
  }

  buildTransferEventFilter(watchedAddresses) {
    return {
      chain: 'BSC',
      topic: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      addresses: watchedAddresses,
    }
  }
}

export const bscAdapter = new BscAdapter()
