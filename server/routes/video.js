import { Router } from 'express'
import multer from 'multer'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, renameSync, unlinkSync, statSync, createReadStream } from 'fs'
import { getDB } from '../db.js'
import { authMiddleware, optionalAuth } from '../middleware/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const uploadDir = join(__dirname, '..', 'uploads', 'videos')

// Ensure video upload dir exists
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

// Multer config for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname) || '.mp4'
    const name = `video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
    cb(null, name)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.webm', '.ogg', '.mov', '.mkv', '.avi']
    const ext = extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) cb(null, true)
    else cb(new Error('不支持的视频格式'))
  }
})

const router = Router()

// ===== Get video info for an episode =====
router.get('/video-stream', optionalAuth, (req, res) => {
  try {
    const { episode, list } = req.query
    const db = getDB()

    // Return access map for all episodes
    if (!episode) {
      const courses = db.prepare(`
        SELECT episode_id, access_level, has_stream_video, bilibili_id, youtube_id
        FROM courses WHERE has_stream_video = 1 OR access_level != 'free' OR bilibili_id != '' OR youtube_id != ''
      `).all()
      return res.json({
        ok: true,
        episodes: courses.map(c => ({
          id: c.episode_id,
          access_level: c.access_level,
          hasStreamVideo: !!c.has_stream_video,
          hasBilibili: !!c.bilibili_id,
          hasYoutube: !!c.youtube_id,
        }))
      })
    }

    // Get video info for specific episode
    const stream = db.prepare('SELECT * FROM video_streams WHERE episode_id = ?').get(episode)
    const course = db.prepare('SELECT youtube_id, bilibili_id, local_video_path, access_level FROM courses WHERE episode_id = ?').get(episode)

    if (stream) {
      return res.json({
        ok: true,
        stream: {
          id: stream.id,
          episodeId: stream.episode_id,
          bilibiliId: stream.bilibili_id || course?.bilibili_id || '',
          localPath: stream.local_path || '',
          qiniuKey: stream.qiniu_key || '',
          quality: stream.quality,
          duration: stream.duration,
          accessLevel: stream.access_level,
        },
        bilibiliId: stream.bilibili_id || course?.bilibili_id || '',
        localPath: stream.local_path || '',
        qiniuKey: stream.qiniu_key || '',
        youtubeId: course?.youtube_id || null,
      })
    }

    // Fallback to course data
    return res.json({
      ok: true,
      stream: null,
      bilibiliId: course?.bilibili_id || '',
      localPath: course?.local_video_path || '',
      youtubeId: course?.youtube_id || null,
    })
  } catch (err) {
    console.error('Video stream error:', err)
    res.json({ ok: false, error: '获取视频信息失败' })
  }
})

// ===== Upload video (local storage) =====
router.post('/video-upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    if (!req.file) return res.json({ ok: false, error: '未选择文件' })

    const fileUrl = `/uploads/videos/${req.file.filename}`
    res.json({
      ok: true,
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
      originalName: req.file.originalname,
    })
  } catch (err) {
    console.error('Video upload error:', err)
    res.json({ ok: false, error: '上传失败' })
  }
})

// ===== Serve video files with range request support =====
router.get('/video-file/:filename', (req, res) => {
  try {
    const filePath = join(uploadDir, req.params.filename)
    if (!existsSync(filePath)) return res.status(404).json({ error: '视频不存在' })

    const stat = statSync(filePath)
    const fileSize = stat.size
    const range = req.headers.range

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      })
      createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      })
      createReadStream(filePath).pipe(res)
    }
  } catch (err) {
    console.error('Video serve error:', err)
    res.status(500).json({ error: '视频加载失败' })
  }
})

// ===== Save video info (after upload or bilibili set) =====
router.post('/video-stream', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })

    const { episodeId, bilibiliId, localPath, qiniuKey, youtubeId, title, accessLevel, duration } = req.body
    const db = getDB()

    // Check if stream already exists for this episode
    const existing = db.prepare('SELECT id FROM video_streams WHERE episode_id = ?').get(episodeId)

    if (existing) {
      db.prepare(`
        UPDATE video_streams SET
          bilibili_id = COALESCE(?, bilibili_id),
          local_path = COALESCE(?, local_path),
          qiniu_key = COALESCE(?, qiniu_key),
          access_level = COALESCE(?, access_level),
          title = COALESCE(?, title),
          duration = COALESCE(?, duration)
        WHERE episode_id = ?
      `).run(bilibiliId || '', localPath || '', qiniuKey || '', accessLevel || 'plus_pro', title || '', duration || 0, episodeId)
    } else {
      db.prepare(`
        INSERT INTO video_streams (episode_id, bilibili_id, local_path, qiniu_key, video_key, access_level, title, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(episodeId, bilibiliId || '', localPath || '', qiniuKey || '', `ep${episodeId}`, accessLevel || 'plus_pro', title || '', duration || 0)
    }

    // Update course record
    const updates = []
    const params = []
    if (bilibiliId) { updates.push('bilibili_id = ?'); params.push(bilibiliId) }
    if (localPath) { updates.push('local_video_path = ?'); params.push(localPath) }
    if (youtubeId) { updates.push('youtube_id = ?'); params.push(youtubeId) }
    if (accessLevel) { updates.push('access_level = ?'); params.push(accessLevel) }
    updates.push('has_stream_video = 1')
    updates.push("updated_at = datetime('now')")
    params.push(episodeId)

    if (updates.length > 2) {
      db.prepare(`UPDATE courses SET ${updates.join(', ')} WHERE episode_id = ?`).run(...params)
    } else {
      db.prepare("UPDATE courses SET has_stream_video = 1, updated_at = datetime('now') WHERE episode_id = ?").run(episodeId)
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Video stream save error:', err)
    res.json({ ok: false, error: '保存失败' })
  }
})

// ===== Update video access level =====
router.patch('/video-stream', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const { episode } = req.query
    const { accessLevel } = req.body
    const db = getDB()

    if (accessLevel) {
      db.prepare('UPDATE video_streams SET access_level = ? WHERE episode_id = ?').run(accessLevel, episode)
      db.prepare('UPDATE courses SET access_level = ? WHERE episode_id = ?').run(accessLevel, episode)
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Video patch error:', err)
    res.json({ ok: false, error: '更新失败' })
  }
})

// ===== Delete video =====
router.delete('/video-stream', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()

    // Get video info before deleting
    const stream = db.prepare('SELECT * FROM video_streams WHERE episode_id = ?').get(req.query.episode)

    db.prepare('DELETE FROM video_streams WHERE episode_id = ?').run(req.query.episode)
    db.prepare("UPDATE courses SET has_stream_video = 0, bilibili_id = '', local_video_path = '' WHERE episode_id = ?").run(req.query.episode)

    // Delete local file if exists
    if (stream?.local_path) {
      const filePath = join(__dirname, '..', stream.local_path.replace(/^\//, ''))
      try { if (existsSync(filePath)) unlinkSync(filePath) } catch {}
    }

    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

// ===== Qiniu upload token (placeholder) =====
router.get('/qiniu-token', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })

    // TODO: Replace with real Qiniu SDK integration
    // const qiniu = require('qiniu')
    // const mac = new qiniu.auth.digest.Mac(accessKey, secretKey)
    // const putPolicy = new qiniu.rs.PutPolicy({ scope: bucket })
    // const uploadToken = putPolicy.uploadToken(mac)

    res.json({
      ok: true,
      uploadToken: 'placeholder-token',
      uploadUrl: 'https://upload.qiniup.com',
      bucket: process.env.QINIU_BUCKET || 'your-bucket',
      domain: process.env.QINIU_DOMAIN || 'https://your-cdn.example.com',
      message: '七牛云上传 Token（需配置 .env 中的 QINIU_ACCESS_KEY, QINIU_SECRET_KEY, QINIU_BUCKET, QINIU_DOMAIN）',
    })
  } catch (err) {
    res.json({ ok: false, error: '获取上传凭证失败' })
  }
})

// ===== Qiniu callback =====
router.post('/qiniu-callback', authMiddleware, (req, res) => {
  try {
    const { episodeId, key, size } = req.body
    const db = getDB()

    // Save video stream info
    const existing = db.prepare('SELECT id FROM video_streams WHERE episode_id = ?').get(episodeId)
    if (existing) {
      db.prepare("UPDATE video_streams SET qiniu_key = ?, file_size = ? WHERE episode_id = ?").run(key, size || 0, episodeId)
    } else {
      db.prepare("INSERT INTO video_streams (episode_id, qiniu_key, video_key, file_size) VALUES (?, ?, ?, ?)").run(episodeId, key, `ep${episodeId}`, size || 0)
    }

    db.prepare("UPDATE courses SET has_stream_video = 1, updated_at = datetime('now') WHERE episode_id = ?").run(episodeId)

    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: '回调处理失败' })
  }
})

// ===== Legacy: stream upload URL (admin) =====
router.post('/stream', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const uid = `local-${Date.now()}`
    res.json({ ok: true, uploadURL: '/api/video-upload', uid })
  } catch (err) { res.json({ ok: false, error: '获取上传链接失败' }) }
})

// ===== SSE stream (presence) =====
router.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
  res.write('data: {"type":"connected"}\n\n')
  const interval = setInterval(() => res.write('data: {"type":"heartbeat"}\n\n'), 30000)
  req.on('close', () => clearInterval(interval))
})

export default router
