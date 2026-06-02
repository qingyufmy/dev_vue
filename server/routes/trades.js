import { Router } from 'express'
import { getDB } from '../db.js'
import { authMiddleware, optionalAuth } from '../middleware/auth.js'

const router = Router()

router.get('/trades', optionalAuth, (req, res) => {
  try {
    const { id } = req.query
    const db = getDB()

    if (id) {
      const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(id)
      return res.json({ ok: true, trade })
    }

    const trades = db.prepare(`
      SELECT t.*, u.nickname FROM trades t LEFT JOIN users u ON t.user_id = u.id
      WHERE t.is_public = 1 ORDER BY t.trade_date DESC, t.created_at DESC LIMIT 50
    `).all()

    res.json({
      ok: true,
      trades: trades.map(t => ({
        id: t.id,
        trade_date: t.trade_date,
        symbol: t.symbol,
        direction: t.direction,
        result: t.result,
        entry_price: t.entry_price,
        exit_price: t.exit_price,
        profit_pct: t.profit_pct,
        notes: t.notes,
        screenshot_url: t.screenshot_url,
      }))
    })
  } catch (err) { res.json({ ok: false, error: '获取战绩失败' }) }
})

router.post('/trades', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const { trade_date, symbol, direction, result, entry_price, exit_price, profit_pct, notes, screenshot_url } = req.body
    const db = getDB()
    const result2 = db.prepare(`
      INSERT INTO trades (user_id, trade_date, title, symbol, direction, result, entry_price, exit_price, profit_pct, notes, screenshot_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, trade_date || '', `${symbol} ${direction === 'long' ? '做多' : '做空'}`, symbol || '', direction || '', result || '', entry_price || '', exit_price || '', profit_pct || '', notes || '', screenshot_url || '')

    res.json({ ok: true, tradeId: result2.lastInsertRowid })
  } catch (err) { res.json({ ok: false, error: '创建失败' }) }
})

router.delete('/trades', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()
    db.prepare('DELETE FROM trades WHERE id = ?').run(req.query.id)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

export default router
