import { Router } from 'express'
import { fetchSentiment } from '../services/sentiment.js'
import { cacheGetJSON, cacheSetJSON } from '../redis.js'

const router = Router()
const CACHE_KEY = 'sentiment:data'
const CACHE_TTL = 2100

router.get('/sentiment', async (req, res) => {
  try {
    const cached = await cacheGetJSON(CACHE_KEY)
    if (cached) return res.json({ ok: true, data: cached.data, updatedAt: cached.updatedAt, source: cached.source || 'IG' })

    const data = await fetchSentiment()
    const updatedAt = new Date().toISOString()
    await cacheSetJSON(CACHE_KEY, { data, updatedAt, source: 'IG' }, CACHE_TTL)
    res.json({ ok: true, data, updatedAt, source: 'IG' })
  } catch (err) {
    console.error('[Sentiment] Error:', err.message)
    res.json({ ok: false, error: '获取情绪数据失败' })
  }
})

router.post('/sentiment/refresh', async (req, res) => {
  try {
    const data = await fetchSentiment()
    const updatedAt = new Date().toISOString()
    await cacheSetJSON(CACHE_KEY, { data, updatedAt, source: 'IG' }, CACHE_TTL)
    res.json({ ok: true, data, updatedAt, source: 'IG' })
  } catch (err) {
    console.error('[Sentiment] Refresh error:', err.message)
    res.json({ ok: false, error: '刷新失败' })
  }
})

export default router
