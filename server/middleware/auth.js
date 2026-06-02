import jwt from 'jsonwebtoken'
import { getDB } from '../db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'wall-street-skill-secret'

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: '请先登录' })
  }

  const token = authHeader.slice(7)
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    const db = getDB()
    const user = db.prepare('SELECT id, email, nickname, avatar, role, plan, plan_expires_at, referral_code, referral_credit, telegram_id FROM users WHERE id = ?').get(decoded.userId)
    if (!user) {
      return res.status(401).json({ ok: false, error: '用户不存在' })
    }
    req.user = user
    next()
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
      const db = getDB()
      req.user = db.prepare('SELECT id, email, nickname, avatar, role, plan, referral_code, referral_credit FROM users WHERE id = ?').get(decoded.userId)
    } catch {}
  }
  next()
}

export function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '需要管理员权限' })
  }
  next()
}

export function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' })
}
