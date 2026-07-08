import { queryOne, queryRun } from './db.js'

export const BILIBILI_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' }

export async function fetchBilibiliVideo(bvid) {
  const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: BILIBILI_HEADERS
  })
  const data = await resp.json()
  if (data.code !== 0 || !data.data) return null
  const d = data.data
  return {
    cover: d.pic ? d.pic.replace('http://', 'https://') : '',
    duration: d.duration || 0,
    title: d.title || '',
    cid: d.cid || 0,
  }
}

export function calculatePlanExpiry(period, fromDate) {
  const base = fromDate ? new Date(fromDate) : new Date(Date.now() + 8 * 3600_000)
  if (period === 'lifetime') {
    return '2099-12-31 23:59:59'
  } else if (period === 'year') {
    base.setFullYear(base.getFullYear() + 1)
  } else {
    base.setMonth(base.getMonth() + 1)
  }
  return base.toISOString().replace('T', ' ').substring(0, 19)
}

export async function processReferralCommission(userId, amount, plan, planLabel, period) {
  if (amount <= 0) return
  try {
    const referral = await queryOne(
      "SELECT r.id, r.referrer_id FROM referrals r WHERE r.referred_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 1",
      [userId]
    )
    if (!referral) return
    const rule = await queryOne(
      'SELECT rate_bps FROM referral_rules WHERE plan = ? AND period = ? AND enabled = 1',
      [plan, period]
    )
    const rateBps = rule ? rule.rate_bps : 1000
    const commissionDollars = amount * rateBps / 10000
    await queryRun(
      'UPDATE referrals SET amount_cents = ?, commission = ?, plan_label = ?, attributed_at = NOW() WHERE id = ?',
      [amount, commissionDollars, planLabel, referral.id]
    )
    await queryRun(
      'INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)',
      [referral.referrer_id, 'system', '💰 返佣到账', `您邀请的用户已付款 $${amount.toFixed(2)}，返佣 $${commissionDollars.toFixed(2)} 待审核确认`]
    )
  } catch (refErr) {
    console.error('[Referral] Commission error:', refErr.message)
  }
}
