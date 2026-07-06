import QRCode from 'qrcode'

const USDT_CONTRACTS = {
  TRON: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  ETH: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  BSC: '0x55d398326f99059fF775485246999027B3197955',
  SOL: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
}

const CHAIN_IDS = {
  ETH: 1,
  BSC: 56,
}

function buildPaymentURI(chain, address, amount) {
  switch (chain) {
    case 'TRON':
      return `tron:${address}?contract=${USDT_CONTRACTS.TRON}&amount=${amount}`
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
