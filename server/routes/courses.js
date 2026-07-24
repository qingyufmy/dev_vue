import { Router } from 'express'
import { queryAll, queryOne } from '../db.js'
import { optionalAuth, authMiddleware } from '../middleware/auth.js'
import { fetchBilibiliVideo } from '../utils.js'
import { canAccessMembershipLevel } from '../membership.js'
import { existsSync } from 'fs'
import { parseCourseAttachmentMetadata, resolveCourseAttachmentPath, serializeCourseAttachment } from '../course-attachments.js'

const router = Router()

// Get course items
router.get('/course-items', optionalAuth, async (req, res) => {
  try {
    const courses = await queryAll(`
      SELECT c.*, c.bilibili_id as bilibiliId,
        vs.duration as vs_duration,
        (SELECT COUNT(*) FROM course_resources cr WHERE cr.episode_id = c.episode_id AND cr.type = 'attachment') AS attachment_count
      FROM courses c
      LEFT JOIN video_streams vs ON vs.episode_id = c.episode_id
      WHERE c.status = 'published' ORDER BY c.created_at DESC
    `)

    res.json({
      ok: true,
      courses: courses.map(c => {
        const canAccess = canAccessMembershipLevel(req.user, c.access_level)
        return ({
        id: c.episode_id,
        episodeId: c.episode_id,
        number: c.number,
        title: c.title,
        description: c.description,
        category: c.category,
        contentType: c.content_type,
        duration: (c.duration && !isNaN(c.duration) ? formatDurationSeconds(c.duration) : c.duration) || (c.vs_duration ? formatDurationSeconds(c.vs_duration) : ''),
        youtubeId: canAccess ? c.youtube_id : null,
        bilibiliId: canAccess ? (c.bilibili_id || '') : '',
        cover: c.cover ? (c.cover.includes('.hdslb.com/') ? `/api/bilibili-proxy?url=${encodeURIComponent(c.cover)}` : c.cover.replace(/^http:\/\//, 'https://')) : c.cover,
        gradient: c.gradient,
        articleUrl: canAccess ? c.article_url : '',
        articleObjectKey: canAccess ? c.article_object_key : '',
        accessLevel: c.access_level,
        hasStreamVideo: Boolean(c.has_stream_video),
        quizCount: c.quiz_count,
        knowledgeCount: c.knowledge_count,
        mindmapCount: c.mindmap_count,
        structureCount: c.structure_count,
        attachmentCount: Number(c.attachment_count || 0),
        status: c.status,
        sortOrder: c.sort_order,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        })
      }),
      source: 'local-db'
    })
  } catch (err) {
    console.error('Course items error:', err)
    res.json({ ok: false, error: '获取课程列表失败' })
  }
})

router.get('/course-items/:id/attachments', optionalAuth, async (req, res) => {
  try {
    const course = await queryOne('SELECT episode_id, access_level, status FROM courses WHERE episode_id = ?', [req.params.id])
    if (!course || (course.status !== 'published' && req.user?.role !== 'admin')) {
      return res.status(404).json({ ok:false, error:'课程不存在' })
    }
    if (!canAccessMembershipLevel(req.user, course.access_level)) {
      return res.status(403).json({ ok:false, error:'当前会员权限不可下载该课程附件' })
    }
    const rows = await queryAll("SELECT * FROM course_resources WHERE episode_id = ? AND type = 'attachment' ORDER BY sort_order, id", [req.params.id])
    res.json({ ok:true, attachments:rows.map(serializeCourseAttachment) })
  } catch (error) {
    console.error('Course attachments error:', error)
    res.status(500).json({ ok:false, error:'课程附件加载失败' })
  }
})

router.get('/course-items/:id/attachments/:attachmentId/download', optionalAuth, async (req, res) => {
  try {
    const attachment = await queryOne(`SELECT cr.*, c.access_level, c.status AS course_status
      FROM course_resources cr INNER JOIN courses c ON c.episode_id = cr.episode_id
      WHERE cr.id = ? AND cr.episode_id = ? AND cr.type = 'attachment'`, [req.params.attachmentId, req.params.id])
    if (!attachment || (attachment.course_status !== 'published' && req.user?.role !== 'admin')) {
      return res.status(404).json({ ok:false, error:'附件不存在' })
    }
    if (!canAccessMembershipLevel(req.user, attachment.access_level)) {
      return res.status(403).json({ ok:false, error:'当前会员权限不可下载该课程附件' })
    }
    const filePath = resolveCourseAttachmentPath(attachment)
    if (!filePath || !existsSync(filePath)) return res.status(404).json({ ok:false, error:'附件文件不存在' })
    const metadata = parseCourseAttachmentMetadata(attachment)
    res.set('Cache-Control', 'private, no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    return res.download(filePath, metadata.fileName, error => {
      if (error && !res.headersSent) res.status(404).json({ ok:false, error:'附件下载失败' })
    })
  } catch (error) {
    console.error('Course attachment download error:', error)
    if (!res.headersSent) res.status(500).json({ ok:false, error:'附件下载失败' })
  }
})

// Get quiz for episode
router.get('/course-items/:id/quiz', authMiddleware, async (req, res) => {
  try {
    const course = await queryOne('SELECT access_level FROM courses WHERE episode_id = ?', [req.params.id])
    if (!course || !canAccessMembershipLevel(req.user, course.access_level)) {
      return res.status(403).json({ ok:false, error:'当前会员权限不可访问该课程测验' })
    }
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
    const course = await queryOne('SELECT access_level FROM courses WHERE episode_id = ?', [req.params.id])
    if (!course || !canAccessMembershipLevel(req.user, course.access_level)) {
      return res.status(403).json({ ok:false, error:'当前会员权限不可访问该课程资料' })
    }
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
// Get Bilibili video cover + duration by BV ID (proxy for CORS)
router.get('/bilibili-info/:bvid', async (req, res) => {
  try {
    const bvid = req.params.bvid
    const bi = await fetchBilibiliVideo(bvid)
    if (bi) {
      res.json({
        ok: true,
        cover: bi.cover,
        duration: bi.duration,
        title: bi.title || '',
        durationFormatted: bi.duration ? formatDurationSeconds(bi.duration) : ''
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
