import QRCode from 'qrcode'
import { USDT_CONTRACTS } from './constants.js'

const CHAIN_IDS = {
  ETH: 1,
  BSC: 56,
}

export function buildPaymentURI(chain, address, amount) {
  switch (chain) {
    case 'TRON':
      // Binance's scanner expects a plain TRON address for this QR. The
      // contract/amount URI is not consistently recognized by the app.
      return address
    case 'ETH':
      return `ethereum:${address}@${CHAIN_IDS.ETH}?amount=${amount}&contractAddress=${USDT_CONTRACTS.ETH}`
    case 'BSC':
      return `ethereum:${address}@${CHAIN_IDS.BSC}?amount=${amount}&contractAddress=${USDT_CONTRACTS.BSC}`
    case 'SOL':
      return `solana:${address}?amount=${amount}&token=${USDT_CONTRACTS.SOL}`
    default:
      throw new Error(`Unsupported chain for QR: ${chain}`)
  }
}

export async function generatePaymentQR(chain, address, amount) {
  const uri = buildPaymentURI(chain, address, amount)
  const dataUrl = await QRCode.toDataURL(uri, {
    type: 'image/png',
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  })
  return dataUrl
}
