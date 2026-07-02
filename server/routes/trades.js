import { Router } from 'express'
import { queryOne, queryAll, queryRun } from '../db.js'
import { authMiddleware, optionalAuth } from '../middleware/auth.js'

const router = Router()

router.get('/trades', optionalAuth, async (req, res) => {
  try {
    const { id } = req.query

    if (id) {
      const fields = 't.id, t.trade_date, t.symbol, t.direction, t.result, t.entry_price, t.exit_price, t.profit_pct, t.notes, t.screenshot_url, t.title, t.created_at, t.user_id, t.is_public'
      let trade
      if (req.user?.role === 'admin') {
        trade = await queryOne(`SELECT ${fields} FROM trades t WHERE t.id = ?`, [id])
      } else if (req.user?.id) {
        trade = await queryOne(`SELECT ${fields} FROM trades t WHERE t.id = ? AND (t.is_public = 1 OR t.user_id = ?)`, [id, req.user.id])
      } else {
        trade = await queryOne(`SELECT ${fields} FROM trades t WHERE t.id = ? AND t.is_public = 1`, [id])
      }
      if (!trade) return res.json({ ok: false, error: '无权查看或记录不存在' })
      const { user_id, is_public, ...safe } = trade
      return res.json({ ok: true, trade: safe })
    }

    const trades = await queryAll(`
      SELECT t.*, u.nickname FROM trades t LEFT JOIN users u ON t.user_id = u.id
      WHERE t.is_public = 1 ORDER BY t.trade_date DESC, t.created_at DESC LIMIT 50
    `)

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

router.post('/trades', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const { trade_date, symbol, direction, result, entry_price, exit_price, profit_pct, notes, screenshot_url } = req.body
    const result2 = await queryRun(`
      INSERT INTO trades (user_id, trade_date, title, symbol, direction, result, entry_price, exit_price, profit_pct, notes, screenshot_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [req.user.id, trade_date || '', `${symbol} ${direction === 'long' ? '做多' : '做空'}`, symbol || '', direction || '', result || '', entry_price || '', exit_price || '', profit_pct || '', notes || '', screenshot_url || ''])

    res.json({ ok: true, tradeId: result2.insertId })
  } catch (err) { res.json({ ok: false, error: '创建失败' }) }
})

router.delete('/trades', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    await queryRun('DELETE FROM trades WHERE id = ?', [req.query.id])
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

export default router
