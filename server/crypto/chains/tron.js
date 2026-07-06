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
      const url = `${this.getApiBaseUrl()}/v1/transactions/${txHash}`
      const headers = await this.getApiHeaders()
      const resp = await fetch(url, { headers })
      if (!resp.ok) return null
      const data = await resp.json()
      if (!data.ret || data.ret.length === 0) return null

      const contract = data.raw_data?.contract?.[0]
      const param = contract?.parameter?.value
      const status = data.ret[0].contractResult === 'SUCCESS' ? 'success' : 'failed'
      const blockNum = data.block_header?.raw_data?.number || 0

      return {
        hash: txHash,
        from: param?.ownerAddress || '',
        to: param?.toAddress || '',
        value: param?.amount || 0,
        blockNumber: blockNum,
        confirmations: 0,
        status,
      }
    } catch {
      return null
    }
  }

  async getConfirmations(txHash) {
    try {
      const tx = await this.getTransaction(txHash)
      if (!tx || !tx.blockNumber) return 0

      const headers = await this.getApiHeaders()
      const nowResp = await fetch(`${this.getApiBaseUrl()}/wallet/getnowblock`, { headers })
      if (!nowResp.ok) return 0
      const nowBlock = await nowResp.json()
      const currentBlock = nowBlock.block_header?.raw_data?.number || 0
      return Math.max(0, currentBlock - tx.blockNumber)
    } catch {
      return 0
    }
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
