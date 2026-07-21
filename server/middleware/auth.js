import jwt from 'jsonwebtoken'
import { queryOne, queryRun } from '../db.js'
import { JWT_SECRET, JWT_EXPIRY } from '../config.js'

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
    queryOne("SELECT id, email, phone, nickname, avatar, role, plan, plan_expires_at, referral_code, referral_credit, telegram_id FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL", [decoded.userId])
      .then(async user => {
        if (!user) {
          return res.status(401).json({ ok: false, error: '用户不存在' })
        }
        // Auto-downgrade expired plan once per middleware pass
        const now = new Date()
        const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at) : null
        if (expiresAt && expiresAt <= now && user.plan !== 'free') {
          user.plan = 'free'
          user.plan_expires_at = null
          // Fire and forget — best-effort DB update
          queryRun('UPDATE users SET plan = ?, plan_expires_at = NULL WHERE id = ?', ['free', user.id]).catch(() => {})
        }
        req.user = user
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
        queryOne("SELECT id, email, phone, nickname, avatar, role, plan, referral_code, referral_credit FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL", [decoded.userId])
        .then(user => { req.user = user; next() })
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

export function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY })
}
