import { Router } from 'express'
import { queryAll } from '../db.js'
import { optionalAuth, authMiddleware } from '../middleware/auth.js'

const router = Router()

// Get course items
router.get('/course-items', optionalAuth, async (req, res) => {
  try {
    const courses = await queryAll(`
      SELECT c.*, c.bilibili_id as bilibiliId,
        vs.duration as vs_duration
      FROM courses c
      LEFT JOIN video_streams vs ON vs.episode_id = c.episode_id
      WHERE c.status = 'published' ORDER BY c.sort_order ASC
    `)

    res.json({
      ok: true,
      courses: courses.map(c => ({
        id: c.episode_id,
        episodeId: c.episode_id,
        number: c.number,
        title: c.title,
        description: c.description,
        category: c.category,
        contentType: c.content_type,
        duration: c.duration || (c.vs_duration ? formatDurationSeconds(c.vs_duration) : ''),
        youtubeId: c.youtube_id,
        bilibiliId: c.bilibili_id || '',
        cover: c.cover,
        gradient: c.gradient,
        articleUrl: c.article_url,
        articleObjectKey: c.article_object_key,
        accessLevel: c.access_level,
        hasStreamVideo: Boolean(c.has_stream_video),
        quizCount: c.quiz_count,
        knowledgeCount: c.knowledge_count,
        mindmapCount: c.mindmap_count,
        structureCount: c.structure_count,
        status: c.status,
        sortOrder: c.sort_order,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
      source: 'local-db'
    })
  } catch (err) {
    console.error('Course items error:', err)
    res.json({ ok: false, error: '获取课程列表失败' })
  }
})

// Get quiz for episode
router.get('/course-items/:id/quiz', authMiddleware, async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM quiz_questions WHERE episode_id = ? ORDER BY sort_order', [req.params.id])
    const questions = rows.map(q => ({
      id: q.id,
      question: q.question,
      options: JSON.parse(q.options || '[]'),
      answer: q.answer ?? q.correct_index ?? 0,
      explanation: q.explanation || '',
      explanations: JSON.parse(q.explanations || '[]'),
      hint: q.hint || '',
      status: q.status || 'published',
      sortOrder: q.sort_order || 0,
    }))
    res.json({ ok: true, questions })
  } catch (err) {
    res.json({ ok: false, error: '获取测验失败' })
  }
})

// Get resources for episode
router.get('/course-items/:id/resources', authMiddleware, async (req, res) => {
  try {
    const resources = await queryAll('SELECT * FROM course_resources WHERE episode_id = ? ORDER BY sort_order', [req.params.id])

    const knowledgePoints = resources.filter(r => r.type === 'knowledge').map(r => ({
      id: r.id, title: r.title, content: r.content, url: r.url
    }))
    const mindmapItems = resources.filter(r => r.type === 'mindmap').map(r => {
      const item = { id: r.id, title: r.title, image: r.url }
      // Parse structure JSON if available
      if (r.structure) {
        try { item.structure = JSON.parse(r.structure) } catch { item.structure = null }
      }
      return item
    })

    res.json({ ok: true, knowledgePoints, mindmapItems })
  } catch (err) {
    res.json({ ok: false, error: '获取资源失败' })
  }
})

// Get Bilibili video duration by BV ID
router.get('/bilibili-duration/:bvid', async (req, res) => {
  try {
    const bvid = req.params.bvid
    const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' }
    })
    const data = await resp.json()
    if (data.code === 0 && data.data?.duration) {
      res.json({ ok: true, duration: data.data.duration, cover: data.data.pic || '' })
    } else {
      res.json({ ok: false, error: '获取时长失败' })
    }
  } catch (err) {
    res.json({ ok: false, error: 'Bilibili API 请求失败' })
  }
})

// Get Bilibili video cover + duration by BV ID (proxy for CORS)
router.get('/bilibili-info/:bvid', async (req, res) => {
  try {
    const bvid = req.params.bvid
    const resp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' }
    })
    const data = await resp.json()
    if (data.code === 0) {
      const d = data.data
      res.json({
        ok: true,
        cover: d.pic || '',
        duration: d.duration || 0,
        title: d.title || '',
        durationFormatted: d.duration ? formatDurationSeconds(d.duration) : ''
      })
    } else {
      res.json({ ok: false, error: '获取B站信息失败' })
    }
  } catch (err) {
    res.json({ ok: false, error: 'Bilibili API 请求失败' })
  }
})

function formatDurationSeconds(seconds) {
  const s = Number(seconds)
  if (!s || s <= 0) return ''
  const mins = Math.floor(s / 60)
  const secs = Math.floor(s % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export default router
