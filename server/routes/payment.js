import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, queryRun } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()

const PLANS = {
  free: { name: '免费版', price: 0, month: 0, year: 0, lifetime: 0 },
  plus: { name: 'Plus', month: 2900, year: 29000, lifetime: 99000 },
  pro: { name: 'Pro', month: 10000, year: 100000, lifetime: 399000 },
  premium: { name: '高级版', month: 2900, year: 29000, lifetime: 99000 },
}

const PERIOD_LABELS = { month: '月付', year: '年付', lifetime: '终身' }

router.get('/payment', authMiddleware, async (req, res) => {
  try {
    const { preview, plan, period, use_referral_credit } = req.query
    if (!preview) return res.json({ ok: false, error: '缺少参数' })

    const planInfo = PLANS[plan]
    if (!planInfo) return res.json({ ok: false, error: '未知套餐' })

    const periodKey = period === 'yearly' ? 'year' : period
    const amount = planInfo[periodKey] || planInfo.month

    // Calculate credit from existing plan
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

    // Referral credit
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
    const { plan, period, use_referral_credit } = req.body
    const planInfo = PLANS[plan]
    if (!planInfo) return res.json({ ok: false, error: '未知套餐' })

    const periodKey = period === 'yearly' ? 'year' : period
    const amount = planInfo[periodKey] || planInfo.month

    // Calculate credits
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

    // Create order
    await queryRun(`
      INSERT INTO orders (order_no, order_id, user_id, plan, plan_label, period, period_label, amount, amount_confirmed, status, status_label, payment_method, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', '已完成', 'local', NOW())
    `, [orderNo, orderId, req.user.id, plan, planInfo.name, periodKey, PERIOD_LABELS[periodKey] || period, amount, finalAmount])

    // Update user plan
    const expiresAt = periodKey === 'lifetime' ? '2099-12-31' : new Date(Date.now() + (periodKey === 'year' ? 365 : 30) * 86400000 + 8 * 3600_000).toISOString().split('T')[0]
    await queryRun("UPDATE users SET plan = ?, plan_period = ?, plan_expires_at = ?, updated_at = NOW() WHERE id = ?", [plan, periodKey, expiresAt, req.user.id])

    // Deduct referral credit if used
    if (referralCredit > 0) {
      await queryRun("UPDATE users SET referral_credit = GREATEST(0, referral_credit - ?), updated_at = NOW() WHERE id = ?", [referralCredit, req.user.id])
    }

    // Calculate referral commission: find pending referral for this user, update with actual order amount
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
        // Notify referrer
        await queryRun(
          'INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)',
          [referral.referrer_id, 'system', '💰 返佣到账', `您邀请的用户已付款 $${(finalAmount/100).toFixed(2)}，返佣 $${(commissionCents/100).toFixed(2)} 待审核确认`]
        )
      }
    } catch (refErr) {
      console.error('Referral commission error:', refErr.message)
    }

    // If paid fully with credit
    if (finalAmount === 0 && (credit > 0 || referralCredit > 0)) {
      return res.json({ ok: true, paid_with_credit: true, orderNo })
    }

    res.json({ ok: true, orderNo, checkout_url: `/?payment=success` })
  } catch (err) {
    console.error('Payment error:', err)
    res.json({ ok: false, error: '创建订单失败' })
  }
})

export default router
