import { tronAdapter } from './tron.js'
import { ethAdapter } from './eth.js'
import { bscAdapter } from './bsc.js'
import { solAdapter } from './sol.js'

export const adapters = {
  TRON: tronAdapter,
  ETH: ethAdapter,
  BSC: bscAdapter,
  SOL: solAdapter,
}

export function getAdapter(chainName) {
  const adapter = adapters[chainName]
  if (!adapter) throw new Error(`No adapter for chain: ${chainName}`)
  return adapter
}
