import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, queryRun, queryAll, withTransaction, logAudit } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { getRequiredConfirmations, validateAddress } from '../crypto/wallet.js'
import { adapters } from '../crypto/chains/index.js'
import { generatePaymentQR } from '../crypto/qr.js'
import { getFixedAddressForChain, generateUniqueAmount, resetFixedAddressCache } from '../crypto/fixed-address.js'
import { calculatePlanExpiry } from '../utils.js'
import { broadcastAdminEvent } from '../bridge-ws.js'
import { enqueuePaymentSideEffect, schedulePaymentSideEffects } from '../jobs/payment-side-effects.js'

const router = Router()

const DEFAULT_PLANS = {
  free: { name: '免费版', price: 0, month: 0, year: 0, lifetime: 0 },
  plus: { name: 'Plus', month: 29, year: 290, lifetime: 990 },
  pro: { name: 'Pro', month: 100, year: 1000, lifetime: 3990 },
  premium: { name: '高级版', month: 29, year: 290, lifetime: 990 },
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

const SUPPORTED_CHAINS = ['TRON', 'TRC20']

function rowsFrom(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
  return Array.isArray(result) ? result : []
}

function affectedRows(result) {
  const header = Array.isArray(result) ? result[0] : result
  return Number(header?.affectedRows ?? header?.changes ?? 0)
}

function appliedReferralCredit(balance, amount, requested) {
  if (!requested) return 0
  const available = Math.max(0, Number(balance) || 0)
  const orderAmount = Math.max(0, Number(amount) || 0)
  return Math.min(available, orderAmount)
}

function referralCreditRequested(value) {
  return value === true || value === 1 || value === '1'
}

const CHAIN_MAP = {
  'TRC20': 'TRON', 'ERC20': 'ETH', 'BEP20': 'BSC', 'SPL': 'SOL',
  'TRON': 'TRON', 'ETH': 'ETH', 'BSC': 'BSC', 'SOL': 'SOL',
}

async function getPaymentMode() {
  const row = await queryOne(
    "SELECT value FROM system_config WHERE category = 'crypto_wallet' AND `key` = 'payment_mode'"
  )
  return row?.value || 'fixed'
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
    console.error('[Payment] 获取套餐失败:', err.message)
    res.json({ ok: false, error: '获取套餐失败，请重试' })
  }
})

router.get('/payment/mode', async (req, res) => {
  try {
    const { getFixedAddress } = await import('../crypto/fixed-address.js')
    const fixedAddresses = await getFixedAddress()
    res.json({ ok: true, mode:'fixed', supportedChain:'TRC20', fixedAddresses })
  } catch (err) {
    res.json({ ok: true, mode:'fixed', supportedChain:'TRC20', fixedAddresses:null })
  }
})

router.get('/payment', authMiddleware, async (req, res) => {
  try {
    const { preview, plan, period, use_referral_credit } = req.query
    if (!preview) return res.json({ ok: false, error: '缺少参数' })

    const PLANS = await getPlans()
    const planInfo = PLANS[plan]
    if (!planInfo) return res.json({ ok: false, error: '未知套餐' })

    const periodKey = period === 'yearly' ? 'year' : period === 'monthly' ? 'month' : period
    const priceObj = planInfo[periodKey] || planInfo.month
    const amount = typeof priceObj === 'object' ? priceObj.current : priceObj

    const user = await queryOne('SELECT plan, plan_expires_at, referral_credit FROM users WHERE id = ?', [req.user.id])

    const referralCredit = appliedReferralCredit(user?.referral_credit, amount, use_referral_credit === '1')

    const finalAmount = Math.max(0, amount - referralCredit)
    const label = `${planInfo.name} ${PERIOD_LABELS[periodKey] || PERIOD_LABELS.month}`

    res.json({
      ok: true,
      label,
      plan,
      period: periodKey,
      fullPrice: amount.toFixed(2),
      finalAmount: finalAmount.toFixed(2),
      referral_credit_applied: referralCredit,
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

    const periodKey = period === 'yearly' ? 'year' : period === 'monthly' ? 'month' : period
    const priceObj = planInfo[periodKey] || planInfo.month
    const amount = typeof priceObj === 'object' ? priceObj.current : priceObj

    if (!crypto_chain || !SUPPORTED_CHAINS.includes(crypto_chain)) {
      return res.json({ ok: false, error: '不支持的支付链' })
    }
    const chainKey = CHAIN_MAP[crypto_chain]
    if (!chainKey || !adapters[chainKey]) {
      return res.json({ ok: false, error: '支付链适配器未就绪' })
    }

    const paymentMode = await getPaymentMode()
    if (paymentMode !== 'fixed') {
      return res.json({ ok: false, error: '当前仅支持固定地址 TRC-20 支付' })
    }

    const fixedAddress = await getFixedAddressForChain('TRON')
    if (!validateAddress('TRON', fixedAddress)) {
      return res.json({ ok: false, error: 'TRC-20 收款地址未配置或格式无效，请联系管理员' })
    }

    const orderNo = `WSS${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const orderId = uuidv4()
    const requiredConfirmations = getRequiredConfirmations(chainKey)
    const expiresAtDate = new Date(Date.now() + 30 * 60 * 1000 + 8 * 3600_000)
    const expiresAt = `${expiresAtDate.getUTCFullYear()}-${String(expiresAtDate.getUTCMonth()+1).padStart(2,'0')}-${String(expiresAtDate.getUTCDate()).padStart(2,'0')} ${String(expiresAtDate.getUTCHours()).padStart(2,'0')}:${String(expiresAtDate.getUTCMinutes()).padStart(2,'0')}:${String(expiresAtDate.getUTCSeconds()).padStart(2,'0')}`
    const address = fixedAddress

    const creation = await withTransaction(async (run) => {
      const userRows = rowsFrom(await run(
        'SELECT plan, plan_expires_at, referral_credit FROM users WHERE id = ? FOR UPDATE',
        [req.user.id]
      ))
      const user = userRows[0]
      if (!user) throw new Error('USER_NOT_FOUND')

      const existingRows = rowsFrom(await run(
        `SELECT order_id, order_no, crypto_address, crypto_amount, crypto_expires_at,
                crypto_chain, amount_confirmed, referral_credit_applied
         FROM orders o
         WHERE o.user_id = ? AND o.plan = ? AND o.period = ? AND o.crypto_chain = ? AND o.status = 'pending'
           AND o.crypto_expires_at > DATE_ADD(NOW(), INTERVAL 15 MINUTE)
           AND EXISTS (
             SELECT 1 FROM crypto_watch_list w
             WHERE w.order_id = o.order_id AND w.status IN ('pending', 'confirming')
           )
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id, plan, periodKey, chainKey]
      ))
      if (existingRows[0]) return { kind: 'existing', order: existingRows[0] }

      const referralCredit = appliedReferralCredit(user.referral_credit, amount, referralCreditRequested(use_referral_credit))
      const finalAmount = Math.max(0, amount - referralCredit)

      const deductCredit = async () => {
        if (referralCredit <= 0) return
        const result = await run(
          `UPDATE users SET referral_credit = referral_credit - ?, updated_at = NOW()
           WHERE id = ? AND referral_credit >= ?`,
          [referralCredit, req.user.id, referralCredit]
        )
        if (affectedRows(result) !== 1) throw new Error('REFERRAL_CREDIT_CONFLICT')
      }

      if (finalAmount === 0) {
        await run(`
          INSERT INTO orders (order_no, order_id, user_id, plan, plan_label, period, period_label,
            amount, amount_confirmed, referral_credit_applied, status, status_label, payment_method, paid_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', '已完成', 'credit', NOW())
        `, [orderNo, orderId, req.user.id, plan, planInfo.name, periodKey, PERIOD_LABELS[periodKey] || period,
          amount, finalAmount, referralCredit])

        const baseDate = user.plan_expires_at && new Date(user.plan_expires_at + 'T23:59:59+08:00') > new Date()
          ? new Date(user.plan_expires_at + 'T23:59:59+08:00') : null
        const planExpiresAt = calculatePlanExpiry(periodKey, baseDate)
        await run("UPDATE users SET plan = ?, plan_period = ?, plan_expires_at = ?, plan_source = 'paid', updated_at = NOW() WHERE id = ?", [plan, periodKey, planExpiresAt, req.user.id])
        await deductCredit()
        await enqueuePaymentSideEffect(run, { orderId, userId:req.user.id })
        return { kind: 'credit', finalAmount, referralCredit }
      }

      const usdtAmount = await generateUniqueAmount(finalAmount, orderId, plan, periodKey, {
        chain: chainKey,
        address,
        run,
      })
      await run(`
        INSERT INTO orders (order_no, order_id, user_id, plan, plan_label, period, period_label,
          amount, amount_confirmed, referral_credit_applied, status, status_label, payment_method,
          crypto_chain, crypto_address, crypto_amount, crypto_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '待支付', 'crypto', ?, ?, ?, ?)
      `, [orderNo, orderId, req.user.id, plan, planInfo.name, periodKey, PERIOD_LABELS[periodKey] || period,
        amount, finalAmount, referralCredit, chainKey, address, usdtAmount, expiresAt])
      await run(
        `INSERT INTO crypto_watch_list
           (order_id, user_id, chain, address, expected_amount, status, required_confirmations, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [orderId, req.user.id, chainKey, address, usdtAmount, requiredConfirmations, expiresAt]
      )
      await deductCredit()
      return { kind: 'pending', finalAmount, referralCredit, usdtAmount }
    })

    if (creation.kind === 'existing') {
      const existingOrder = creation.order
      const qrCode = await generatePaymentQR(chainKey, existingOrder.crypto_address, existingOrder.crypto_amount).catch(() => null)
      return res.json({
        ok: true,
        label: `${planInfo.name} ${PERIOD_LABELS[periodKey] || '月付'}`,
        orderNo: existingOrder.order_no,
        orderId: existingOrder.order_id,
        crypto_chain: chainKey,
        crypto_address: existingOrder.crypto_address,
        crypto_amount: parseFloat(existingOrder.crypto_amount),
        usd_amount: Number(existingOrder.amount_confirmed || 0).toFixed(2),
        referral_credit_applied: Number(existingOrder.referral_credit_applied || 0),
        expires_at: existingOrder.crypto_expires_at,
        required_confirmations: getRequiredConfirmations(chainKey),
        qr_code: qrCode,
        payment_mode: paymentMode,
        reused: true,
      })
    }

    if (creation.kind === 'credit') {
      schedulePaymentSideEffects()
      broadcastAdminEvent('commercial', 'payment_confirmed', {
        user_id:Number(req.user.id), order_no:orderNo, status:'paid', plan:String(plan || ''),
      }, { scopes:['overview', 'commercial', 'users'], refresh:true })

      return res.json({ ok: true, paid_with_credit: true, orderNo })
    }

    const usdtAmount = creation.usdtAmount
    const mode = 'fixed'

    broadcastAdminEvent('commercial', 'order_created', {
      user_id:Number(req.user.id), order_no:orderNo, status:'pending', plan:String(plan || ''),
    }, { scopes:['overview', 'commercial'], refresh:true })

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
      crypto_chain: chainKey,
      crypto_address: address,
      crypto_amount: usdtAmount,
      usd_amount: creation.finalAmount.toFixed(2),
      referral_credit_applied: creation.referralCredit,
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

router.post('/payment/cancel/:orderId', authMiddleware, async (req, res) => {
  try {
    const result = await withTransaction(async (run) => {
      const orders = rowsFrom(await run(
        `SELECT order_id, status, referral_credit_applied FROM orders
         WHERE order_id = ? AND user_id = ? FOR UPDATE`,
        [req.params.orderId, req.user.id]
      ))
      const order = orders[0]
      if (!order) return { error: '订单不存在' }
      if (order.status !== 'pending') return { error: '订单无法取消' }

      const updated = await run(
        `UPDATE orders SET status = 'cancelled', status_label = '已取消'
         WHERE order_id = ? AND user_id = ? AND status = 'pending'`,
        [req.params.orderId, req.user.id]
      )
      if (affectedRows(updated) !== 1) return { error: '订单状态已变更，无法取消' }
      await run(`UPDATE crypto_watch_list SET status = 'cancelled' WHERE order_id = ?`, [req.params.orderId])

      const creditUsed = Math.max(0, Number(order.referral_credit_applied) || 0)
      if (creditUsed > 0) {
        await run(
          `UPDATE users SET referral_credit = referral_credit + ?, updated_at = NOW() WHERE id = ?`,
          [creditUsed, req.user.id]
        )
      }
      return { ok: true }
    })
    if (result.error) return res.json({ ok: false, error: result.error })

    broadcastAdminEvent('commercial', 'order_cancelled', {
      user_id:Number(req.user.id), order_id:String(req.params.orderId), status:'cancelled',
    }, { scopes:['overview', 'commercial'], refresh:true })

    res.json({ ok: true })
  } catch (err) {
    console.error('[Payment] 取消订单失败:', err.message)
    res.json({ ok: false, error: '取消订单失败' })
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
    res.json({ ok: false, error: '查询余额失败，请重试' })
  }
})

router.post('/admin/crypto/sweep', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sweepAll } = await import('../crypto/sweep.js')
    const result = await sweepAll()
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[Sweep] 归集失败:', err.message)
    res.json({ ok: false, error: '归集失败，请重试' })
  }
})

router.post('/admin/crypto/sweep/:index', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { sweepAddress } = await import('../crypto/sweep.js')
    const result = await sweepAddress(parseInt(req.params.index))
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[Sweep] 单地址归集失败:', err.message)
    res.json({ ok: false, error: '单地址归集失败，请重试' })
  }
})

router.get('/admin/crypto/payment-mode', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { getFixedAddress } = await import('../crypto/fixed-address.js')
    const fixedAddresses = await getFixedAddress()
    res.json({ ok: true, mode:'fixed', supportedChain:'TRC20', fixedAddresses })
  } catch (err) {
    console.error('[PaymentMode] 查询失败:', err.message)
    res.json({ ok: false, error: '查询支付模式失败' })
  }
})

router.post('/admin/crypto/payment-mode', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { mode, fixed_addresses } = req.body
    if (mode !== 'fixed') {
      return res.status(400).json({ ok:false, error:'当前仅支持固定地址 TRC-20 支付' })
    }

    const tronAddress = String(fixed_addresses?.tron || '').trim()
    if (!validateAddress('TRON', tronAddress)) {
      return res.status(400).json({ ok:false, error:'TRON 收款地址格式无效' })
    }

    await queryRun(
      `INSERT INTO system_config (category, \`key\`, value, label, sort_order)
       VALUES ('crypto_wallet', 'payment_mode', ?, '支付模式', 0)
       ON DUPLICATE KEY UPDATE value = ?`,
      ['fixed', 'fixed']
    )
    await queryRun(
      `INSERT INTO system_config (category, \`key\`, value, label, sort_order)
       VALUES ('crypto_wallet', 'fixed_tron_address', ?, 'TRC-20 固定收款地址', 10)
       ON DUPLICATE KEY UPDATE value = VALUES(value), label = VALUES(label)`,
      [tronAddress]
    )
    resetFixedAddressCache()
    await logAudit({ userId:req.user.id, action:'payment_trc20_config_updated', targetType:'system_config',
      detail:JSON.stringify({ chain:'TRC20', configured:true, address_suffix:tronAddress.slice(-6) }), ip:req.ip, userAgent:req.get('user-agent') })
    res.json({ ok:true, mode:'fixed', supportedChain:'TRC20' })
  } catch (err) {
    console.error('[PaymentMode] 保存失败:', err.message)
    res.status(500).json({ ok:false, error:'保存 TRC-20 收款配置失败，请重试' })
  }
})

export default router
