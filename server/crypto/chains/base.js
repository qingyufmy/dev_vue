export class BaseChainAdapter {
  name = ''
  chainId = ''

  constructor() {
    if (new.target === BaseChainAdapter) {
      throw new Error('BaseChainAdapter cannot be instantiated directly')
    }
  }

  deriveAddress(index) {
    const raw = this._deriveRaw(index)
    return { address: raw.address, publicKey: raw.publicKey }
  }

  _deriveRaw(index) {
    throw new Error('Subclass must implement _deriveRaw()')
  }

  async getTransaction(txHash) {
    throw new Error('Subclass must implement getTransaction()')
  }

  async getConfirmations(txHash) {
    const tx = await this.getTransaction(txHash)
    if (!tx) return 0
    return tx.confirmations || 0
  }

  buildTransferEventFilter(watchedAddresses) {
    throw new Error('Not implemented')
  }

  getRequiredConfirmations() {
    throw new Error('Not implemented')
  }

  getApiBaseUrl() {
    throw new Error('Not implemented')
  }
}
