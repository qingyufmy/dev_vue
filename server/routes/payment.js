import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, queryRun, queryAll, withTransaction } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { deriveAddress, getAddressCount, saveAddress, getRequiredConfirmations } from '../crypto/wallet.js'
import { adapters } from '../crypto/chains/index.js'
import { generatePaymentQR } from '../crypto/qr.js'
import { addWatchAddress } from '../crypto/monitor.js'
import { getFixedAddressForChain, generateUniqueAmount, resetFixedAddressCache } from '../crypto/fixed-address.js'

const router = Router()

const DEFAULT_PLANS = {
  free: { name: '免费版', price: 0, month: 0, year: 0, lifetime: 0 },
  plus: { name: 'Plus', month: 2900, year: 29000, lifetime: 99000 },
  pro: { name: 'Pro', month: 10000, year: 100000, lifetime: 399000 },
  premium: { name: '高级版', month: 2900, year: 29000, lifetime: 99000 },
}

async function getPlans() {
  try {
    const rows = await queryAll(
      "SELECT `key`, `value` FROM system_config WHERE category = 'plan_prices'"
    )
    if (rows.length === 0) return DEFAULT_PLANS

    const plans = JSON.parse(JSON.stringify(DEFAULT_PLANS))
    for (const row of rows) {
      const key = row.key
      const val = parseInt(row.value) || 0
      if (val <= 0) continue

      if (key.endsWith('_original')) {
        const parts = key.replace('_original', '').split('_')
        const planName = parts[0]
        const period = parts[1]
        if (plans[planName]) {
          plans[planName][`${period}_original`] = val
        }
      } else {
        const parts = key.split('_')
        const planName = parts[0]
        const period = parts[1]
        if (plans[planName] && period) {
          plans[planName][period] = val
        }
      }
    }
    return plans
  } catch {
    return DEFAULT_PLANS
  }
}

const PERIOD_LABELS = { month: '月付', year: '年付', lifetime: '终身' }

const SUPPORTED_CHAINS = ['ETH', 'BSC', 'TRON', 'SOL', 'TRC20', 'ERC20', 'BEP20', 'SPL']

const CHAIN_MAP = {
  'TRC20': 'TRON', 'ERC20': 'ETH', 'BEP20': 'BSC', 'SPL': 'SOL',
  'TRON': 'TRON', 'ETH': 'ETH', 'BSC': 'BSC', 'SOL': 'SOL',
}

async function getUsdtUsdRate() {
  try {
    const resp = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTUSD')
    const data = await resp.json()
    if (data?.price) return parseFloat(data.price)
  } catch {}
  return 1.0
}

async function getPaymentMode() {
  const row = await queryOne(
    "SELECT value FROM system_config WHERE category = 'crypto_wallet' AND `key` = 'payment_mode'"
  )
  return row?.value || 'dynamic'
}

router.get('/plans', async (req, res) => {
  try {
    const plans = await getPlans()
    const result = {}
    for (const [name, info] of Object.entries(plans)) {
      if (name === 'free' || name === 'premium') continue
      result[name] = {
        name: info.name,
        month: { current: info.month, original: info.month_original || null },
        year: { current: info.year, original: info.year_original || null },
      }
    }
    res.json({ ok: true, plans: result })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

router.get('/payment/mode', async (req, res) => {
  try {
    const mode = await getPaymentMode()
    let fixedAddresses = null
    if (mode === 'fixed') {
      const { getFixedAddress } = await import('../crypto/fixed-address.js')
      fixedAddresses = await getFixedAddress()
    }
    res.json({ ok: true, mode, fixedAddresses })
  } catch (err) {
    res.json({ ok: true, mode: 'dynamic' })
  }
})

router.get('/payment', authMiddleware, async (req, res) => {
  try {
    const { preview, plan, period, use_referral_credit } = req.query
    if (!preview) return res.json({ ok: false, error: '缺少参数' })

    const PLANS = await getPlans()
    const planInfo = PLANS[plan]
    if (!planInfo) return res.json({ ok: false, error: '未知套餐' })

    const periodKey = period === 'yearly' ? 'year' : period
    const priceObj = planInfo[periodKey] || planInfo.month
    const amount = typeof priceObj === 'object' ? priceObj.current : priceObj

    let credit = 0
    const user = await queryOne('SELECT plan, plan_expires_at, referral_credit FROM users WHERE id = ?', [req.user.id])
    if (user?.plan && user.plan !== 'free' && user.plan_expires_at) {
      const expiresAt = new Date(user.plan_expires_at + 'T23:59:59+08:00')
      const now = new Date()
      if (expiresAt > now) {
        const daysRemaining = Math.ceil((expiresAt - now) / 86400000)
        const dailyRate = PLANS[user.plan]?.month ? PLANS[user.plan].month / 30 : 0
        credit = Math.round(dailyRate * daysRemaining)
      }
    }

    let referralCredit = 0
    if (use_referral_credit === '1') {
      referralCredit = user?.referral_credit || 0
    }

    const finalAmount = Math.max(0, amount - credit - referralCredit)
    const label = `${planInfo.name} ${PERIOD_LABELS[periodKey] || PERIOD_LABELS.month}`

    res.json({
      ok: true,
      label,
      plan,
      period: periodKey,
      fullPrice: (amount / 100).toFixed(2),
      finalAmount: (finalAmount / 100).toFixed(2),
      credit: (credit / 100).toFixed(2),
      daysRemaining: credit > 0 ? Math.ceil(credit / (PLANS[user?.plan]?.month ? PLANS[user.plan].month / 30 : 1)) : 0,
      referral_credit_applied_cents: referralCredit,
    })
  } catch (err) {
    res.json({ ok: false, error: '获取支付信息失败' })
  }
})

router.post('/payment', authMiddleware, async (req, res) => {
  try {
    const { plan, period, use_referral_credit, crypto_chain } = req.body
    const PLANS = await getPlans()
    const planInfo = PLANS[plan]
    if (!planInfo) return res.json({ ok: false, error: '未知套餐' })

    const periodKey = period === 'yearly' ? 'year' : period
    const priceObj = planInfo[periodKey] || planInfo.month
    const amount = typeof priceObj === 'object' ? priceObj.current : priceObj

    if (!crypto_chain || !SUPPORTED_CHAINS.includes(crypto_chain)) {
      return res.json({ ok: false, error: '不支持的支付链' })
    }
    const chainKey = CHAIN_MAP[crypto_chain]
    if (!chainKey || !adapters[chainKey]) {
      return res.json({ ok: false, error: '支付链适配器未就绪' })
    }

    let credit = 0
    const user = await queryOne('SELECT plan, plan_expires_at, referral_credit FROM users WHERE id = ?', [req.user.id])
    if (user?.plan && user.plan !== 'free' && user.plan_expires_at) {
      const expiresAt = new Date(user.plan_expires_at + 'T23:59:59+08:00')
      if (expiresAt > new Date()) {
        const daysRemaining = Math.ceil((expiresAt - new Date()) / 86400000)
        credit = Math.round((PLANS[user.plan]?.month || 0) / 30 * daysRemaining)
      }
    }

    let referralCredit = 0
    if (use_referral_credit && user.referral_credit > 0) {
      referralCredit = user.referral_credit
    }

    const finalAmount = Math.max(0, amount - credit - referralCredit)
    const orderNo = `WSS${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const orderId = uuidv4()

    if (finalAmount === 0) {
      await withTransaction(async (run) => {
        await run(`
          INSERT INTO orders (order_no, order_id, user_id, plan, plan_label, period, period_label, amount, amount_confirmed, status, status_label, payment_method, paid_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', '已完成', 'credit', NOW())
        `, [orderNo, orderId, req.user.id, plan, planInfo.name, periodKey, PERIOD_LABELS[periodKey] || period, amount, finalAmount])

        const expiresAt = periodKey === 'lifetime' ? '2099-12-31' : new Date(Date.now() + (periodKey === 'year' ? 365 : 30) * 86400000 + 8 * 3600_000).toISOString().split('T')[0]
        await run("UPDATE users SET plan = ?, plan_period = ?, plan_expires_at = ?, updated_at = NOW() WHERE id = ?", [plan, periodKey, expiresAt, req.user.id])

        if (referralCredit > 0) {
          await run("UPDATE users SET referral_credit = GREATEST(0, referral_credit - ?), updated_at = NOW() WHERE id = ?", [referralCredit, req.user.id])
        }
      })

      try {
        const referral = await queryOne(
          "SELECT r.id, r.referrer_id, r.status FROM referrals r WHERE r.referred_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 1",
          [req.user.id]
        )
        if (referral) {
          const rule = await queryOne(
            'SELECT rate_bps FROM referral_rules WHERE plan = ? AND period = ? AND enabled = 1',
            [plan, periodKey]
          )
          const rateBps = rule ? rule.rate_bps : 1000
          const commissionCents = Math.round(finalAmount * rateBps / 10000)
          await queryRun(
            'UPDATE referrals SET amount_cents = ?, commission = ?, plan_label = ?, attributed_at = NOW() WHERE id = ?',
            [finalAmount, commissionCents, planInfo.name, referral.id]
          )
          await queryRun(
            'INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)',
            [referral.referrer_id, 'system', '💰 返佣到账', `您邀请的用户已付款 $${(finalAmount/100).toFixed(2)}，返佣 $${(commissionCents/100).toFixed(2)} 待审核确认`]
          )
        }
      } catch (refErr) {
        console.error('[Payment] Referral commission error:', refErr.message)
      }

      return res.json({ ok: true, paid_with_credit: true, orderNo })
    }

    const requiredConfirmations = getRequiredConfirmations(chainKey)
    const rate = await getUsdtUsdRate()
    const baseUsdtAmount = finalAmount / 100 / rate
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)

    const paymentMode = await getPaymentMode()
    let address, usdtAmount, mode

    if (paymentMode === 'fixed') {
      address = await getFixedAddressForChain(chainKey)
      if (!address) {
        return res.json({ ok: false, error: '固定地址未配置，请在管理后台设置' })
      }
      usdtAmount = await generateUniqueAmount(baseUsdtAmount, orderId, plan, periodKey)
      mode = 'fixed'
    } else {
      const index = await getAddressCount(chainKey)
      address = deriveAddress(chainKey, index)
      await saveAddress(chainKey, index, address)
      usdtAmount = parseFloat(baseUsdtAmount.toFixed(2))
      mode = 'dynamic'
    }

    await withTransaction(async (run) => {
      await run(`
        INSERT INTO orders (order_no, order_id, user_id, plan, plan_label, period, period_label, amount, amount_confirmed, status, status_label, payment_method, crypto_chain, crypto_address, crypto_amount, crypto_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', '待支付', 'crypto', ?, ?, ?, ?)
      `, [orderNo, orderId, req.user.id, plan, planInfo.name, periodKey, PERIOD_LABELS[periodKey] || period, amount, crypto_chain, address, usdtAmount, expiresAt])

      if (referralCredit > 0) {
        await run("UPDATE users SET referral_credit = GREATEST(0, referral_credit - ?), updated_at = NOW() WHERE id = ?", [referralCredit, req.user.id])
      }
    })

    if (mode === 'dynamic') {
      await addWatchAddress({
        orderId,
        userId: req.user.id,
        chain: chainKey,
        address,
        expectedAmount: usdtAmount,
        expiresAt,
      })
    }

    try {
      const referral = await queryOne(
        "SELECT r.id, r.referrer_id, r.status FROM referrals r WHERE r.referred_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 1",
        [req.user.id]
      )
      if (referral) {
        const rule = await queryOne(
          'SELECT rate_bps FROM referral_rules WHERE plan = ? AND period = ? AND enabled = 1',
          [plan, periodKey]
        )
        const rateBps = rule ? rule.rate_bps : 1000
        const commissionCents = Math.round(finalAmount * rateBps / 10000)
        await queryRun(
          'UPDATE referrals SET amount_cents = ?, commission = ?, plan_label = ?, attributed_at = NOW() WHERE id = ?',
          [finalAmount, commissionCents, planInfo.name, referral.id]
        )
        await queryRun(
          'INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)',
          [referral.referrer_id, 'system', '💰 返佣到账', `您邀请的用户已付款 $${(finalAmount/100).toFixed(2)}，返佣 $${(commissionCents/100).toFixed(2)} 待审核确认`]
        )
      }
    } catch (refErr) {
      console.error('[Payment] Referral commission error:', refErr.message)
    }

    let qrCode = null
    try {
      qrCode = await generatePaymentQR(chainKey, address, usdtAmount)
    } catch (qrErr) {
      console.error('[Payment] QR generation error:', qrErr.message)
    }

    res.json({
      ok: true,
      label: `${planInfo.name} ${PERIOD_LABELS[periodKey] || '月付'}`,
      orderNo,
      orderId,
      crypto_chain,
      crypto_address: address,
      crypto_amount: usdtAmount,
      usd_amount: (finalAmount / 100).toFixed(2),
      expires_at: expiresAt,
      required_confirmations: requiredConfirmations,
      qr_code: qrCode,
      payment_mode: mode,
    })
  } catch (err) {
    console.error('[Payment] 创建订单失败:', err)
    res.json({ ok: false, error: '创建订单失败' })
  }
})

router.get('/payment/status/:orderId', authMiddleware, async (req, res) => {
  try {
    const order = await queryOne(
      `SELECT o.order_id, o.order_no, o.plan, o.period, o.amount, o.status, o.status_label,
              o.crypto_chain, o.crypto_address, o.crypto_amount, o.crypto_expires_at, o.paid_at,
              w.confirmations, w.required_confirmations, w.tx_hash
       FROM orders o
       LEFT JOIN crypto_watch_list w ON w.order_id = o.order_id
       WHERE o.order_id = ? AND o.user_id = ?`,
      [req.params.orderId, req.user.id]
    )
    if (!order) return res.json({ ok: false, error: '订单不存在' })
    res.json({
      ok: true,
      status: order.status,
      statusLabel: order.status_label,
      confirmations: order.confirmations || 0,
      requiredConfirmations: order.required_confirmations || 0,
      txHash: order.tx_hash,
    })
  } catch (err) {
    console.error('[Payment] 查询订单失败:', err)
    res.json({ ok: false, error: '查询订单失败' })
  }
})

router.get('/admin/crypto/sweep/balances', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { getDerivedAddressesBalance } = await import('../crypto/sweep.js')
    const balances = await getDerivedAddressesBalance()
    const mainAddress = await import('../crypto/wallet.js').then(m => m.getMainAddress())
    res.json({ ok: true, mainAddress, balances })
  } catch (err) {
    console.error('[Sweep] 查询余额失败:', err.message)
    res.json({ ok: false, error: '查询余额失败: ' + err.message })
  }
})

router.post('/admin/crypto/sweep', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sweepAll } = await import('../crypto/sweep.js')
    const result = await sweepAll()
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[Sweep] 归集失败:', err.message)
    res.json({ ok: false, error: '归集失败: ' + err.message })
  }
})

router.post('/admin/crypto/sweep/:index', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sweepAddress } = await import('../crypto/sweep.js')
    const result = await sweepAddress(parseInt(req.params.index))
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[Sweep] 单地址归集失败:', err.message)
    res.json({ ok: false, error: '归集失败: ' + err.message })
  }
})

router.get('/admin/crypto/payment-mode', authMiddleware, adminOnly, async (req, res) => {
  try {
    const mode = await getPaymentMode()
    const { getFixedAddress } = await import('../crypto/fixed-address.js')
    const fixedAddresses = await getFixedAddress()
    res.json({ ok: true, mode, fixedAddresses })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

router.post('/admin/crypto/payment-mode', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mode, fixed_addresses } = req.body
    if (!['dynamic', 'fixed'].includes(mode)) {
      return res.json({ ok: false, error: '无效的支付模式' })
    }

    await queryRun(
      `INSERT INTO system_config (category, \`key\`, value, label, sort_order)
       VALUES ('crypto_wallet', 'payment_mode', ?, '支付模式', 0)
       ON DUPLICATE KEY UPDATE value = ?`,
      [mode, mode]
    )

    if (mode === 'fixed' && fixed_addresses) {
      const addrMap = {
        tron: 'fixed_tron_address',
        eth: 'fixed_erc20_address',
        bsc: 'fixed_bep20_address',
        sol: 'fixed_sol_address',
      }
      for (const [chain, value] of Object.entries(fixed_addresses)) {
        const key = addrMap[chain]
        if (key && value) {
          await queryRun(
            `INSERT INTO system_config (category, \`key\`, value, label, sort_order)
             VALUES ('crypto_wallet', ?, ?, ?, 10)
             ON DUPLICATE KEY UPDATE value = ?`,
            [key, value, `${chain.toUpperCase()} 固定收款地址`, value]
          )
        }
      }
    }

    const { resetFixedAddressCache } = await import('../crypto/fixed-address.js')
    resetFixedAddressCache()

    res.json({ ok: true })
  } catch (err) {
    console.error('[PaymentMode] 切换失败:', err.message)
    res.json({ ok: false, error: '切换失败: ' + err.message })
  }
})

export default router
