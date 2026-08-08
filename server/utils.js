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

function beijingDateParts(value) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/)
    if (match) {
      return {
        year:Number(match[1]), month:Number(match[2]), day:Number(match[3]),
        hour:Number(match[4] || 0), minute:Number(match[5] || 0), second:Number(match[6] || 0),
      }
    }
  }

  const date = value == null ? new Date() : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('invalid_plan_expiry_base')
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    year:Number(map.year), month:Number(map.month), day:Number(map.day),
    hour:Number(map.hour), minute:Number(map.minute), second:Number(map.second),
  }
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function padDatePart(value) {
  return String(value).padStart(2, '0')
}

export function calculatePlanExpiry(period, fromDate) {
  if (period === 'lifetime') return '2099-12-31 23:59:59'

  const base = beijingDateParts(fromDate)
  let year = base.year
  let month = base.month
  if (period === 'year') {
    year += 1
  } else {
    const monthIndex = year * 12 + (month - 1) + 1
    year = Math.floor(monthIndex / 12)
    month = monthIndex % 12 + 1
  }
  const day = Math.min(base.day, daysInMonth(year, month))
  return `${year}-${padDatePart(month)}-${padDatePart(day)} ${padDatePart(base.hour)}:${padDatePart(base.minute)}:${padDatePart(base.second)}`
}

export async function processReferralCommission(userId, amount, plan, planLabel, period, orderId, { run } = {}) {
  const paidAmount = Number(amount)
  const paymentOrderId = String(orderId || '').trim()
  if (!Number.isFinite(paidAmount) || paidAmount <= 0 || !paymentOrderId) return
  const selectOne = run
    ? async (sql, params) => {
        const result = await run(sql, params)
        const rows = Array.isArray(result?.[0]) ? result[0] : []
        return rows[0] || null
      }
    : queryOne
  const execute = run
    ? async (sql, params) => {
        const result = await run(sql, params)
        const header = Array.isArray(result) ? result[0] : result
        return { changes:Number(header?.affectedRows ?? header?.changes ?? 0), insertId:header?.insertId }
      }
    : queryRun
  try {
    const referral = await selectOne(
      `SELECT r.id, r.referrer_id, r.order_id FROM referrals r
       WHERE r.referred_id = ? AND r.status = 'pending'
         AND (r.order_id IS NULL OR r.order_id = ?)
       ORDER BY r.created_at DESC LIMIT 1`,
      [userId, paymentOrderId]
    )
    if (!referral) return
    if (String(referral.order_id || '') === paymentOrderId) return { status:'already_recorded' }
    const rulePeriod = period === 'month' ? 'monthly' : period === 'year' ? 'yearly' : period
    const rule = await selectOne(
      'SELECT rate_bps FROM referral_rules WHERE plan = ? AND period = ? AND enabled = 1',
      [plan, rulePeriod]
    )
    const configuredRate = Number(rule?.rate_bps)
    const rateBps = Number.isFinite(configuredRate) ? configuredRate : 1000
    const commissionDollars = paidAmount * rateBps / 10000
    const recorded = await execute(
      `UPDATE referrals SET order_id = ?, cash_amount = ?, commission = ?, plan_label = ?, attributed_at = NOW()
       WHERE id = ? AND status = 'pending' AND order_id IS NULL`,
      [paymentOrderId, paidAmount, commissionDollars, planLabel, referral.id]
    )
    if (Number(recorded?.changes || 0) !== 1) return { status:'conflict' }
    await execute(
      'INSERT IGNORE INTO notifications (user_id, type, title, message, dedupe_key) VALUES (?, ?, ?, ?, ?)',
      [referral.referrer_id, 'system', '💰 返佣到账', `您邀请的用户已付款 $${paidAmount.toFixed(2)}，返佣 $${commissionDollars.toFixed(2)} 待审核确认`, `referral:${referral.id}:${paymentOrderId}`]
    )
    return { status:'recorded', commission:commissionDollars }
  } catch (refErr) {
    if (run) throw refErr
    console.error('[Referral] Commission error:', refErr.message)
  }
}
