import { Router } from 'express'
import { fetchSentiment } from '../services/sentiment.js'
import { cacheGetJSON, cacheSetJSON } from '../redis.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'

const router = Router()
const CACHE_KEY = 'sentiment:data'
const CACHE_TTL = 2100

let _fetchPromise = null

router.get('/sentiment', async (req, res) => {
  try {
    const cached = await cacheGetJSON(CACHE_KEY)
    if (cached) return res.json({ ok: true, data: cached.data, updatedAt: cached.updatedAt, source: cached.source || 'IG' })

    if (_fetchPromise) return res.json({ ok: true, data: [], updatedAt: null, source: 'IG', status: 'fetching' })

    res.json({ ok: true, data: [], updatedAt: null, source: 'IG', status: 'empty' })
  } catch (err) {
    console.error('[Sentiment] Error:', err.message)
    res.json({ ok: false, error: '获取情绪数据失败' })
  }
})

router.post('/sentiment/refresh', authMiddleware, adminOnly, async (req, res) => {
  try {
    if (_fetchPromise) return res.json({ ok: false, error: '正在抓取中，请稍后' })
    _fetchPromise = fetchSentiment().then(async (data) => {
      const hasValid = data.some(d => d.longPct !== null)
      const updatedAt = new Date().toISOString()
      if (hasValid) {
        await cacheSetJSON(CACHE_KEY, { data, updatedAt, source: 'IG' }, CACHE_TTL)
      }
      return { ok: true, data, updatedAt, source: 'IG' }
    }).catch((err) => {
      console.error('[Sentiment] Refresh error:', err.message)
      return { ok: false, error: '刷新失败' }
    }).finally(() => { _fetchPromise = null })
    res.json(await _fetchPromise)
  } catch (err) {
    console.error('[Sentiment] Refresh error:', err.message)
    res.json({ ok: false, error: '刷新失败' })
  }
})

export default router
