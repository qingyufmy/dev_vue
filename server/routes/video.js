import { Router } from 'express'
import multer from 'multer'
import { join, dirname, extname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, unlinkSync, statSync, createReadStream } from 'fs'
import { queryOne, queryAll, queryRun } from '../db.js'
import { authMiddleware, optionalAuth, adminOnly } from '../middleware/auth.js'

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
router.get('/video-stream', optionalAuth, async (req, res) => {
  try {
    const { episode, list } = req.query

    // Return access map for all episodes
    if (!episode) {
      const courses = await queryAll(`
        SELECT episode_id, access_level, has_stream_video, bilibili_id, youtube_id
        FROM courses WHERE has_stream_video = 1 OR access_level != 'free' OR bilibili_id != '' OR youtube_id != ''
      `)
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
    const stream = await queryOne('SELECT * FROM video_streams WHERE episode_id = ?', [episode])
    const course = await queryOne('SELECT youtube_id, bilibili_id, local_video_path, access_level FROM courses WHERE episode_id = ?', [episode])

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
router.post('/video-upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    if (!req.file) return res.json({ ok: false, error: '未选择文件' })

    const fileUrl = `/uploads/videos/${req.file.filename}`
    const filePath = join(uploadDir, req.file.filename)
    
    // Extract duration + cover thumbnail using ffprobe + ffmpeg if available
    let duration = ''
    let cover = ''
    try {
      const { execFile } = await import('child_process')
      // 异步调用 ffprobe，不阻塞 Node.js 事件循环
      const probeResult = await new Promise((resolve, reject) => {
        execFile('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', filePath
        ], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
      })
      const seconds = parseFloat(probeResult.trim())
      if (seconds > 0) {
        const mins = Math.floor(seconds / 60)
        const secs = Math.floor(seconds % 60)
        duration = `${mins}:${String(secs).padStart(2, '0')}`
        // Extract thumbnail at 5s or 10% of video duration
        const coversDir = join(__dirname, '..', 'uploads', 'covers')
        if (!existsSync(coversDir)) { const { mkdirSync } = await import('fs'); mkdirSync(coversDir, { recursive: true }) }
        const coverFilename = `cover_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg`
        const coverPath = join(coversDir, coverFilename)
        const seekTime = Math.min(5, Math.floor(seconds * 0.1))
        try {
          // 异步调用 ffmpeg 截取封面
          await new Promise((resolve, reject) => {
            execFile('ffmpeg', [
              '-ss', String(seekTime), '-i', filePath,
              '-vframes', '1', '-q:v', '2', '-y', coverPath
            ], { timeout: 10000 }, (err) => err ? reject(err) : resolve())
          })
          cover = `/uploads/covers/${coverFilename}`
        } catch {}
      }
    } catch {}
    
    res.json({
      ok: true,
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
      originalName: req.file.originalname,
      duration,
      durationSeconds: duration ? parseInt(duration.split(':')[0]) * 60 + parseInt(duration.split(':')[1]) : 0,
      cover,
    })
  } catch (err) {
    console.error('Video upload error:', err)
    res.json({ ok: false, error: '上传失败' })
  }
})

// ===== Serve video files with range request support =====
router.get('/video-file/:filename', (req, res) => {
  try {
    const filePath = resolve(join(uploadDir, req.params.filename))
    if (!filePath.startsWith(resolve(uploadDir))) {
      return res.status(403).json({ error: '禁止访问' })
    }
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
router.post('/video-stream', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })

    const { episodeId, bilibiliId, localPath, qiniuKey, youtubeId, title, accessLevel, duration, cover } = req.body

    // Check if stream already exists for this episode
    const existing = await queryOne('SELECT id FROM video_streams WHERE episode_id = ?', [episodeId])

    if (existing) {
      await queryRun(`
        UPDATE video_streams SET
          bilibili_id = COALESCE(?, bilibili_id),
          local_path = COALESCE(?, local_path),
          qiniu_key = COALESCE(?, qiniu_key),
          access_level = COALESCE(?, access_level),
          title = COALESCE(?, title),
          duration = COALESCE(?, duration)
        WHERE episode_id = ?
      `, [bilibiliId || '', localPath || '', qiniuKey || '', accessLevel || 'plus_pro', title || '', duration || 0, episodeId])
    } else {
      await queryRun(`
        INSERT INTO video_streams (episode_id, bilibili_id, local_path, qiniu_key, video_key, access_level, title, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [episodeId, bilibiliId || '', localPath || '', qiniuKey || '', `ep${episodeId}`, accessLevel || 'plus_pro', title || '', duration || 0])
    }

    // Sync course record: duration (always sync when provided) + auto-fetch bilibili cover
    const courseUpdates = ['updated_at = NOW()', 'has_stream_video = 1']
    const courseParams = []
    if (duration && duration !== '0') {
      courseUpdates.unshift('duration = ?'); courseParams.unshift(duration)
    }
    if (bilibiliId) {
      courseUpdates.push('bilibili_id = ?'); courseParams.push(bilibiliId)
      // Auto-fetch cover + duration from Bilibili
      try {
        const bi = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bilibiliId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' }
        })
        const bd = await bi.json()
        if (bd.code === 0 && bd.data) {
          // Cover (always fetch, https enforced to avoid mixed content)
          if (bd.data.pic) {
            courseUpdates.push('cover = ?')
            courseParams.push(bd.data.pic.replace('http://', 'https://'))
          }
          // Duration (auto-fetch if frontend didn't send one)
          if ((!duration || duration === '0') && bd.data.duration) {
            courseUpdates.push('duration = ?')
            courseParams.push(bd.data.duration)
          }
        }
      } catch {}
    }
    if (localPath) { courseUpdates.push('local_video_path = ?'); courseParams.push(localPath) }
    if (cover) { courseUpdates.push('cover = ?'); courseParams.push(cover) }
    if (youtubeId) { courseUpdates.push('youtube_id = ?'); courseParams.push(youtubeId) }
    if (accessLevel) { courseUpdates.push('access_level = ?'); courseParams.push(accessLevel) }
    courseParams.push(episodeId)
    await queryRun(`UPDATE courses SET ${courseUpdates.join(', ')} WHERE episode_id = ?`, courseParams)

    res.json({ ok: true })
  } catch (err) {
    console.error('Video stream save error:', err)
    res.json({ ok: false, error: '保存失败' })
  }
})

// ===== Update video access level =====
router.patch('/video-stream', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const { episode } = req.query
    const { accessLevel } = req.body

    if (accessLevel) {
      await queryRun('UPDATE video_streams SET access_level = ? WHERE episode_id = ?', [accessLevel, episode])
      await queryRun('UPDATE courses SET access_level = ? WHERE episode_id = ?', [accessLevel, episode])
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Video patch error:', err)
    res.json({ ok: false, error: '更新失败' })
  }
})

// ===== Delete video =====
router.delete('/video-stream', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })

    // Get video info before deleting
    const stream = await queryOne('SELECT * FROM video_streams WHERE episode_id = ?', [req.query.episode])

    await queryRun('DELETE FROM video_streams WHERE episode_id = ?', [req.query.episode])
    await queryRun("UPDATE courses SET has_stream_video = 0, bilibili_id = '', local_video_path = '' WHERE episode_id = ?", [req.query.episode])

    // Delete local file if exists
    if (stream?.local_path) {
      const filePath = join(__dirname, '..', stream.local_path.replace(/^\//, ''))
      try { if (existsSync(filePath)) unlinkSync(filePath) } catch {}
    }

    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

// ===== Qiniu callback =====
router.post('/qiniu-callback', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { episodeId, key, size } = req.body

    // Input validation
    const eid = Number(episodeId)
    if (!eid || eid <= 0 || !Number.isInteger(eid)) {
      return res.json({ ok: false, error: 'episodeId 必须是正整数' })
    }
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      return res.json({ ok: false, error: 'key 必须是非空字符串' })
    }
    const fileSize = size != null ? Number(size) : 0
    if (size != null && (isNaN(fileSize) || fileSize < 0)) {
      return res.json({ ok: false, error: 'size 必须是非负数字' })
    }

    // Save video stream info
    const existing = await queryOne('SELECT id FROM video_streams WHERE episode_id = ?', [eid])
    if (existing) {
      await queryRun("UPDATE video_streams SET qiniu_key = ?, file_size = ? WHERE episode_id = ?", [key.trim(), fileSize, eid])
    } else {
      await queryRun("INSERT INTO video_streams (episode_id, qiniu_key, video_key, file_size) VALUES (?, ?, ?, ?)", [eid, key.trim(), `ep${eid}`, fileSize])
    }

    await queryRun("UPDATE courses SET has_stream_video = 1, updated_at = NOW() WHERE episode_id = ?", [eid])

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
