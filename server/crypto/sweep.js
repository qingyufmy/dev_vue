import { queryAll, queryOne, queryRun, beijingNow } from '../db.js'
import { deriveAddress, derivePrivateKey, getAddressCount, getMainAddress, loadTronWeb, getCryptoWalletApiKey } from './wallet.js'
import { USDT_CONTRACTS } from './constants.js'

const TRONGRID_API = 'https://api.trongrid.io'

async function getTronWebInstance() {
  const TronWeb = await loadTronWeb()
  return new TronWeb({
    fullHost: TRONGRID_API,
    headers: { 'TRON-PRO-API-KEY': await getCryptoWalletApiKey('TRON') }
  })
}

export async function getDerivedAddressesBalance() {
  const count = await getAddressCount('TRON')
  const results = []

  for (let i = 0; i < count; i++) {
    const address = deriveAddress('TRON', i)
    try {
      const resp = await fetch(`${TRONGRID_API}/v1/accounts/${address}/trc20?contract_address=${USDT_CONTRACTS.TRON}&limit=1`, {
        headers: { 'TRON-PRO-API-KEY': await getCryptoWalletApiKey('TRON') }
      })
      const data = await resp.json()

      const trxBalResp = await fetch(`${TRONGRID_API}/v1/accounts/${address}`, {
        headers: { 'TRON-PRO-API-KEY': await getCryptoWalletApiKey('TRON') }
      })
      const trxBalData = await trxBalResp.json()

      let usdtBalance = 0
      if (data.data && data.data.length > 0) {
        const latest = data.data.find(t => t.to === address && t.token_address === USDT_CONTRACTS.TRON.toLowerCase())
        if (latest) {
          usdtBalance = parseInt(latest.value) / 1e6
        }
      }

      const trxBalance = (trxBalData.data?.[0]?.balance || 0) / 1e6

      results.push({
        index: i,
        address,
        usdtBalance: parseFloat(usdtBalance.toFixed(2)),
        trxBalance: parseFloat(trxBalance.toFixed(2)),
        canSweep: usdtBalance > 0 && trxBalance > 0.5,
      })
    } catch (err) {
      results.push({
        index: i,
        address,
        usdtBalance: 0,
        trxBalance: 0,
        canSweep: false,
        error: err.message,
      })
    }
  }

  return results
}

export async function sweepAddress(fromIndex) {
  const fromAddress = deriveAddress('TRON', fromIndex)
  const toAddress = await getMainAddress()
  const privateKey = derivePrivateKey('TRON', fromIndex)

  const tronWeb = await getTronWebInstance()
  tronWeb.setAddress(fromAddress)

  const contract = await tronWeb.contract().at(USDT_CONTRACTS.TRON)

  const balance = await contract.methods.balanceOf(fromAddress).call()
  const balanceNum = parseInt(balance.toString()) / 1e6

  if (balanceNum <= 0) {
    return { success: false, error: '余额为 0' }
  }

  const amount = Math.floor(balanceNum * 1e6)

  const tx = await contract.methods.transfer(toAddress, amount).send({
    from: fromAddress,
    feeLimit: 100000000,
  })

  await queryRun(
    `INSERT INTO audit_logs (user_id, action, detail) VALUES (?, 'sweep_usdt', ?)`,
    [0, JSON.stringify({ from: fromAddress, to: toAddress, amount: balanceNum, txHash: tx.txid })]
  )

  return {
    success: true,
    txHash: tx.txid,
    from: fromAddress,
    to: toAddress,
    amount: balanceNum,
  }
}

export async function sweepAll() {
  const mainAddress = await getMainAddress()
  const balances = await getDerivedAddressesBalance()
  const results = []

  for (const item of balances) {
    if (!item.canSweep) continue

    try {
      const result = await sweepAddress(item.index)
      results.push({
        index: item.index,
        address: item.address,
        ...result,
      })
    } catch (err) {
      results.push({
        index: item.index,
        address: item.address,
        success: false,
        error: err.message,
      })
    }
  }

  return {
    mainAddress,
    totalSwept: results.filter(r => r.success).reduce((sum, r) => sum + (r.amount || 0), 0),
    results,
  }
}
