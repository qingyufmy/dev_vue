import jwt from 'jsonwebtoken'
import { queryOne } from '../db.js'
import { JWT_SECRET, JWT_EXPIRY } from '../config.js'
import { decorateMembership } from '../membership.js'

export function tokenVersionMatches(decoded, user) {
  return Number(decoded?.tokenVersion ?? 0) === Number(user?.token_version ?? 0)
}

export function authMiddleware(req, res, next) {
  // Routers may apply authentication once at a module boundary and again on
  // individual legacy routes. Reuse the verified user instead of querying it
  // twice.
  if (req.user?.id) return next()
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: '请先登录' })
  }

  const token = authHeader.slice(7)
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    queryOne(`SELECT id, email, phone, nickname, avatar, role, plan, plan_source, plan_expires_at,
      (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired,
      referral_code, referral_credit, telegram_id, token_version
      FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [decoded.userId])
      .then(async user => {
        if (!user) {
          return res.status(401).json({ ok: false, error: '用户不存在' })
        }
        if (!tokenVersionMatches(decoded, user)) {
          return res.status(401).json({ ok:false, error:'登录状态已失效，请重新登录' })
        }
        // Preserve the purchased plan for renewal/history. Authorization uses
        // effective_plan and membership_expired instead of rewriting the user.
        req.user = decorateMembership(user)
        next()
      })
      .catch(() => res.status(401).json({ ok: false, error: 'Token无效或已过期' }))
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Token无效或已过期' })
  }
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const decoded = jwt.verify(token, JWT_SECRET)
        queryOne(`SELECT id, email, phone, nickname, avatar, role, plan, plan_source, plan_expires_at,
          (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired,
          referral_code, referral_credit, token_version
          FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [decoded.userId])
        .then(user => {
          if (user && tokenVersionMatches(decoded, user)) req.user = decorateMembership(user)
          next()
        })
        .catch(() => next())
    } catch { next() }
  } else {
    next()
  }
}

export function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '需要管理员权限' })
  }
  next()
}

export function generateToken(userId, tokenVersion = 0) {
  return jwt.sign({ userId, tokenVersion:Number(tokenVersion) || 0 }, JWT_SECRET, { expiresIn: JWT_EXPIRY })
}
