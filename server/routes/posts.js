import { Router } from 'express'
import multer from 'multer'
import { join } from 'path'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { queryOne, queryAll, queryRun, withTransaction } from '../db.js'
import { authMiddleware, optionalAuth } from '../middleware/auth.js'
import { sanitizeRichContent } from '../html-sanitizer.js'
import { createImageAssetName, detectImageType } from '../image-upload.js'
import { PUBLIC_UPLOAD_DIR } from '../config.js'
import { createStorageService } from '../storage/storage-service.js'
import { createMultipartStoredFile, createDirectStorageSession, confirmDirectStorageSession, safeStorageError, loadStoredFile, STORED_FILE_OWNERS } from '../storage/stored-file-service.js'
import { sendStoredFile } from '../storage/stored-file-response.js'

const __uploadDir = PUBLIC_UPLOAD_DIR
if (!existsSync(__uploadDir)) mkdirSync(__uploadDir, { recursive: true })

export function sanitizeContentHtml(html) {
  return sanitizeRichContent(html)
}

const postImageStorage = multer.memoryStorage()
const postImageUpload = multer({
  storage: postImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    // Client MIME is advisory. The route validates the actual magic bytes
    // with detectImageType after multer has buffered the upload.
    cb(null, true)
  },
})

const router = Router()

// Get posts (list or single)
router.get('/posts', optionalAuth, async (req, res) => {
  try {
    const { id, board, category, search, q, tag, sort, page = 1, limit = 20 } = req.query

    // Single post
    if (id) {
      const post = await queryOne(`
        SELECT p.*, u.nickname, u.avatar, u.role as user_role,
               ru.nickname as reply_user_name, ru.avatar as reply_user_avatar
        FROM posts p LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN users ru ON p.last_reply_user_id = ru.id
        WHERE p.id = ?
      `, [id])
      if (!post) return res.json({ ok: false, error: '帖子不存在' })

      await queryRun('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', [id])

      const tags = JSON.parse(post.tags || '[]')
      const tagObjects = tags.map(t => ({ slug: t, label: t }))

      const isAuthor = req.user && req.user.id === post.user_id
      const isAdminUser = req.user && req.user.role === 'admin'

      return res.json({
        ok: true,
        post: {
          id: post.id,
          board: post.board,
          title: post.title,
          content: post.content_text || post.content || '',
          contentHtml: sanitizeContentHtml(post.content_html || post.content || ''),
          contentText: post.content_text || '',
          contentFormat: post.content_html ? 'rich' : 'plain',
          tags: tagObjects,
          images: JSON.parse(post.images || '[]'),
          pinned: !!post.pinned,
          isSticky: !!post.pinned,
          featured: !!post.featured,
          isFeatured: !!post.featured,
          locked: !!post.locked,
          isLocked: !!post.locked,
          threadLocked: !!post.locked,
          replyCount: post.reply_count,
          viewCount: post.view_count + 1,
          imageCount: post.image_count,
          canDelete: isAuthor || isAdminUser,
          canModerate: isAdminUser,
          createdAt: post.created_at,
          lastRepliedAt: post.last_reply_at,
          preview: (post.content_text || '').substring(0, 200),
          user: {
            id: post.user_id,
            name: post.nickname || '匿名',
            avatar: post.avatar,
            isAdmin: post.user_role === 'admin',
          },
          lastReplyUser: post.reply_user_name ? { name: post.reply_user_name, avatar: post.reply_user_avatar } : null,
          participants: [],
        }
      })
    }

    // List posts
    let where = '1=1'
    const params = []

    if (board) { where += ' AND p.board = ?'; params.push(board) }
    if (category && category !== 'all') { where += ' AND p.category = ?'; params.push(category) }
    const searchTerm = search || q
    if (searchTerm) { where += ' AND (p.title LIKE ? OR p.content_text LIKE ?)'; params.push(`%${searchTerm}%`, `%${searchTerm}%`) }
    if (tag) {
      where += ' AND p.tags LIKE ?'
      params.push(`%"${tag}"%`)
    }

    const offset = (Number(page) - 1) * Number(limit)
    const total = (await queryOne(`SELECT COUNT(*) as c FROM posts p WHERE ${where}`, params)).c

    let orderBy = 'p.pinned DESC, '
    if (sort === 'newest') orderBy += 'p.created_at DESC'
    else if (sort === 'hot') orderBy += 'p.view_count DESC'
    else orderBy += 'COALESCE(p.last_reply_at, p.created_at) DESC'

    const posts = await queryAll(`
      SELECT p.*, u.nickname, u.avatar, u.role as user_role,
             ru.nickname as reply_user_name, ru.avatar as reply_user_avatar
      FROM posts p LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN users ru ON p.last_reply_user_id = ru.id
      WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset])

    // Get tags
    const availableTags = await queryAll('SELECT * FROM post_tags ORDER BY count DESC LIMIT 20')

    // Get participants for each post
    const postIds = posts.map(p => p.id)
    const participants = {}
    if (postIds.length) {
      const placeholders = postIds.map(() => '?').join(',')
      const parts = await queryAll(`
        SELECT pr.post_id, u.nickname, u.avatar FROM post_replies pr
        LEFT JOIN users u ON pr.user_id = u.id
        WHERE pr.post_id IN (${placeholders})
        GROUP BY pr.post_id, pr.user_id
        ORDER BY MAX(pr.created_at) DESC
      `, postIds)
      for (const p of parts) {
        if (!participants[p.post_id]) participants[p.post_id] = []
        if (participants[p.post_id].length < 3) participants[p.post_id].push({ name: p.nickname, avatar: p.avatar })
      }
    }

    res.json({
      ok: true,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
      availableTags,
      posts: posts.map(p => {
        const tags = JSON.parse(p.tags || '[]')
        const isAuthor = req.user && req.user.id === p.user_id
        const isAdminUser = req.user && req.user.role === 'admin'
        return {
          id: p.id,
          board: p.board,
          title: p.title,
          preview: (p.content_text || '').substring(0, 120),
          tags: tags.map(t => ({ slug: t, label: t })),
          pinned: !!p.pinned,
          isSticky: !!p.pinned,
          featured: !!p.featured,
          isFeatured: !!p.featured,
          locked: !!p.locked,
          isLocked: !!p.locked,
          threadLocked: !!p.locked,
          replyCount: p.reply_count,
          viewCount: p.view_count,
          imageCount: p.image_count,
          canDelete: isAuthor || isAdminUser,
          canModerate: isAdminUser,
          createdAt: p.created_at,
          lastRepliedAt: p.last_reply_at || p.created_at,
          user: { id: p.user_id, name: p.nickname || '匿名', avatar: p.avatar, isAdmin: p.user_role === 'admin' },
          lastReplyUser: p.reply_user_name ? { name: p.reply_user_name } : null,
          participants: participants[p.id] || [],
        }
      }),
    })
  } catch (err) {
    console.error('Posts error:', err)
    res.json({ ok: false, error: '获取帖子失败' })
  }
})

// Create post
router.post('/posts', authMiddleware, async (req, res) => {
  try {
    const { title, content, contentHtml, contentText, board, category, images, tags, assetIds } = req.body
    if (!title?.trim()) return res.json({ ok: false, error: '标题不能为空' })

    const safeContentHtml = sanitizeContentHtml(contentHtml)
    const tagStr = typeof tags === 'string' ? JSON.stringify(tags.split(',').map(t => t.trim()).filter(Boolean)) : JSON.stringify(tags || [])
    const imageArr = Array.isArray(images) ? images : []
    const assetArr = Array.isArray(assetIds) ? assetIds : []

    const result = await queryRun(`
      INSERT INTO posts (user_id, board, title, content, content_html, content_text, category, tags, images, asset_ids, image_count, last_reply_at, last_reply_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    `, [req.user.id, board || 'ideas', title.trim(), safeContentHtml || contentText || content || '', safeContentHtml || '', contentText || '', category || 'general', tagStr, JSON.stringify(imageArr), JSON.stringify(assetArr), imageArr.length, req.user.id])

    // Update tag counts
    const tagList = typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean) : (tags || [])
    for (const t of tagList) {
      const slug = t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '-')
      await queryRun('INSERT INTO post_tags (slug, label, count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE count = count + 1', [slug, t])
    }

    res.json({ ok: true, success: true, postId: result.insertId })
  } catch (err) {
    console.error('Create post error:', err)
    res.json({ ok: false, error: '发帖失败' })
  }
})

// Update post
router.put('/posts', authMiddleware, async (req, res) => {
  try {
    const { id, title, content, category } = req.body
    const post = await queryOne('SELECT * FROM posts WHERE id = ?', [id])
    if (!post) return res.json({ ok: false, error: '帖子不存在' })
    if (post.user_id !== req.user.id && req.user.role !== 'admin') return res.json({ ok: false, error: '无权编辑' })

    const sanitizedContent = content ? sanitizeContentHtml(content) : post.content
    await queryRun('UPDATE posts SET title = ?, content = ?, category = ?, updated_at = NOW() WHERE id = ?', [title || post.title, sanitizedContent, category || post.category, id])
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '编辑失败' }) }
})

// Delete post
router.delete('/posts', authMiddleware, async (req, res) => {
  try {
    const { id } = req.query
    const post = await queryOne('SELECT * FROM posts WHERE id = ?', [id])
    if (!post) return res.json({ ok: false, error: '帖子不存在' })
    if (post.user_id !== req.user.id && req.user.role !== 'admin') return res.json({ ok: false, error: '无权删除' })

    await queryRun('DELETE FROM posts WHERE id = ?', [id])
    await queryRun('DELETE FROM post_replies WHERE post_id = ?', [id])
    res.json({ ok: true, success: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

// Pin/feature/lock (PATCH)
router.patch('/posts/pin', authMiddleware, async (req, res) => {
  try {
    const { postId, sticky } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    await queryRun('UPDATE posts SET pinned = ? WHERE id = ?', [sticky ? 1 : 0, postId])
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.patch('/posts/feature', authMiddleware, async (req, res) => {
  try {
    const { postId, featured } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    await queryRun('UPDATE posts SET featured = ? WHERE id = ?', [featured ? 1 : 0, postId])
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.patch('/posts/lock', authMiddleware, async (req, res) => {
  try {
    const { postId, locked } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    await queryRun('UPDATE posts SET locked = ? WHERE id = ?', [locked ? 1 : 0, postId])
    res.json({ ok: true })
      } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

// Get post replies
router.get('/post-replies', optionalAuth, async (req, res) => {
  try {
    const { post, page = 1 } = req.query
    const limit = 20
    const offset = (Number(page) - 1) * limit

    const replies = await queryAll(`
      SELECT r.*, u.nickname, u.avatar, u.role as user_role,
             q.content as quote_content, q.user_id as quote_user_id, qu.nickname as quote_user_name,
             q.floor_number as quote_floor_number
      FROM post_replies r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN post_replies q ON r.quote_reply_id = q.id
      LEFT JOIN users qu ON q.user_id = qu.id
      WHERE r.post_id = ? ORDER BY r.created_at ASC LIMIT ? OFFSET ?
    `, [post, limit, offset])

    const total = (await queryOne('SELECT COUNT(*) as c FROM post_replies WHERE post_id = ?', [post])).c

    res.json({
      ok: true,
      success: true,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / limit),
      replies: replies.map(r => ({
        id: r.id,
        content: sanitizeContentHtml(r.content_html || r.content),
        contentText: r.content_text || r.content,
        contentHtml: sanitizeContentHtml(r.content_html || ''),
        floorNumber: r.floor_number || 0,
        images: JSON.parse(r.images || '[]'),
        likes: r.likes,
        createdAt: r.created_at,
        user: { id: r.user_id, name: r.nickname || '匿名', avatar: r.avatar, isAdmin: r.user_role === 'admin' },
        quoteReply: r.quote_reply_id ? {
          id: r.quote_reply_id,
          contentText: r.quote_content,
          user: { name: r.quote_user_name },
          floorNumber: r.quote_floor_number || 0,
        } : null,
      })),
    })
  } catch (err) { res.json({ ok: false, error: '获取回复失败' }) }
})

// Add reply
router.post('/post-replies', authMiddleware, async (req, res) => {
  try {
    const { postId, content, contentHtml, contentText, quoteReplyId, assetIds } = req.body
    if (!postId) return res.json({ ok: false, error: '缺少帖子ID' })
    if (!content?.trim() && !contentHtml && !contentText) return res.json({ ok: false, error: '回复内容不能为空' })

    const post = await queryOne('SELECT locked FROM posts WHERE id = ?', [postId])
    if (post?.locked) return res.json({ ok: false, error: '帖子已锁定' })

    const safeContentHtml = sanitizeContentHtml(contentHtml)

    // Get floor number
    const maxFloorRow = await queryOne('SELECT MAX(floor_number) as m FROM post_replies WHERE post_id = ?', [postId])
    const maxFloor = maxFloorRow?.m || 0

    const result = await queryRun(`
      INSERT INTO post_replies (post_id, user_id, content, content_html, content_text, asset_ids, quote_reply_id, floor_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [postId, req.user.id, safeContentHtml || contentText || content?.trim() || '', safeContentHtml || '', contentText || content?.trim() || '', JSON.stringify(assetIds || []), quoteReplyId || null, maxFloor + 1])

    await queryRun('UPDATE posts SET reply_count = reply_count + 1, last_reply_at = NOW(), last_reply_user_id = ? WHERE id = ?', [req.user.id, postId])

    // Create notification for post author
    const postAuthor = await queryOne('SELECT user_id FROM posts WHERE id = ?', [postId])
    if (postAuthor && postAuthor.user_id !== req.user.id) {
      await queryRun(`
        INSERT INTO notifications (user_id, type, title, message, link)
        VALUES (?, 'reply', '你的帖子有了新回复', ?, ?)
      `, [postAuthor.user_id, `${req.user.nickname || '匿名用户'}回复了你的帖子`, `/posts#${postId}`])
    }

    // Create notification for quoted reply author
    if (quoteReplyId) {
      const quotedReply = await queryOne('SELECT user_id FROM post_replies WHERE id = ?', [quoteReplyId])
      if (quotedReply && quotedReply.user_id !== req.user.id && quotedReply.user_id !== postAuthor?.user_id) {
        await queryRun(`
          INSERT INTO notifications (user_id, type, title, message, link)
          VALUES (?, 'reply_quote', '有人引用了你的回复', ?, ?)
        `, [quotedReply.user_id, `${req.user.nickname || '匿名用户'}引用了你的回复`, `/posts#${postId}`])
      }
    }

    res.json({ ok: true, success: true, replyId: result.insertId })
  } catch (err) {
    console.error('Add reply error:', err)
    res.json({ ok: false, error: '回复失败' })
  }
})

// Delete reply
router.delete('/post-replies', authMiddleware, async (req, res) => {
  try {
    const { id } = req.query
    const reply = await queryOne('SELECT * FROM post_replies WHERE id = ?', [id])
    if (!reply) return res.json({ ok: false, error: '回复不存在' })
    if (reply.user_id !== req.user.id && req.user.role !== 'admin') return res.json({ ok: false, error: '无权删除' })

    await queryRun('DELETE FROM post_replies WHERE id = ?', [id])
    await queryRun('UPDATE posts SET reply_count = GREATEST(0, reply_count - 1) WHERE id = ?', [reply.post_id])
    res.json({ ok: true, success: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

// Report
router.post('/post-reports', authMiddleware, async (req, res) => {
  try {
    const { postId, replyId, reason, detail } = req.body
    await queryRun('INSERT INTO post_reports (post_id, reply_id, user_id, reason, detail) VALUES (?, ?, ?, ?, ?)', [postId || null, replyId || null, req.user.id, reason || '', detail || ''])
    res.json({ ok: true, message: '举报已提交' })
  } catch (err) { res.json({ ok: false, error: '举报失败' }) }
})

router.get('/post-reports', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const reports = await queryAll('SELECT r.*, u.nickname as reporter_name FROM post_reports r LEFT JOIN users u ON r.user_id = u.id ORDER BY r.created_at DESC LIMIT 100')
    res.json({ ok: true, reports })
  } catch (err) { res.json({ ok: false, error: '获取举报失败' }) }
})

// Post images upload
router.post('/post-images', authMiddleware, postImageUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, error: '未收到图片文件' })

    const imageType = detectImageType(req.file.buffer)
    if (!imageType) return res.status(400).json({ ok:false, error:'仅支持真实的 JPEG、PNG、WebP 或 GIF 图片' })
    const assetId = createImageAssetName('img')
    const storage = await createStorageService()
    const result = await createMultipartStoredFile({
      storage, purpose:'image', body:req.file.buffer, originalName:req.file.originalname,
      mimeType:imageType.mimeType, ownerType:STORED_FILE_OWNERS.POST_IMAGE, ownerId:req.user.id,
      createdBy:req.user.id, visibility:'public', allowGif:imageType.mimeType === 'image/gif',
      insertBusiness:async (run, context) => {
        const url = `/api/post-images/${encodeURIComponent(assetId)}/file`
        await run(`INSERT INTO post_assets (asset_id, user_id, file_name, file_type, file_size, url, stored_file_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [assetId, req.user.id, req.file.originalname, imageType.mimeType, req.file.size, url, context.storedFileId])
        return { assetId, url }
      },
    })
    res.json({ ok:true, assetId, url:result.business.url, storage_provider:result.provider, upload_phase:'confirmed' })
  } catch (err) {
    console.error('[Posts] Image upload error:', err)
    const safe = safeStorageError(err)
    res.status(400).json({ ok:false, error:safe.code, code:safe.code, stage:safe.stage, upload_phase:'failed' })
  }
})

// Lightweight preflight used by the browser to avoid sending a multipart
// body to the app when image storage is configured for qiniu.
router.get('/post-images/storage-provider', authMiddleware, async (req, res) => {
  try {
    const storage = await createStorageService()
    res.json({ ok:true, provider:storage.config.effectiveProviders?.image || storage.configuredProvider('image'), expiresAt:new Date(Date.now() + 30_000).toISOString() })
  } catch (error) {
    const safe = safeStorageError(error, 'storage_provider_lookup_failed')
    res.status(400).json({ ok:false, error:safe.code, code:safe.code })
  }
})

router.post('/post-images/upload-session', authMiddleware, async (req, res) => {
  try {
    const storage = await createStorageService()
    const session = await createDirectStorageSession({
      storage, purpose:'image', originalName:req.body?.originalName, mimeType:req.body?.mimeType,
      sizeBytes:req.body?.sizeBytes, ownerType:STORED_FILE_OWNERS.POST_IMAGE, ownerId:req.user.id,
      createdBy:req.user.id, visibility:'public', allowGif:true,
    })
    res.status(201).json({ ok:true, ...session, storage_provider:session.provider, upload_phase:'session_created' })
  } catch (error) {
    const safe = safeStorageError(error, 'storage_session_create_failed')
    res.status(400).json({ ok:false, error:safe.code, code:safe.code, stage:safe.stage, upload_phase:'failed' })
  }
})

router.post('/post-images/confirm', authMiddleware, async (req, res) => {
  try {
    const storage = await createStorageService()
    const completed = await confirmDirectStorageSession({
      storage, sessionId:String(req.body?.sessionId || ''), createdBy:req.user.id, result:{ key:req.body?.key },
      validateSession:async session => {
        if (session.owner_type !== STORED_FILE_OWNERS.POST_IMAGE || Number(session.owner_id) !== Number(req.user.id)) throw Object.assign(new Error('storage_session_owner_mismatch'), { code:'storage_session_owner_mismatch' })
      },
      insertBusiness:async (run, context) => {
        const assetId = createImageAssetName('img')
        const url = `/api/post-images/${encodeURIComponent(assetId)}/file`
        await run(`INSERT INTO post_assets (asset_id, user_id, file_name, file_type, file_size, url, stored_file_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [assetId, req.user.id, context.metadata.originalName, context.metadata.mimeType, context.metadata.sizeBytes, url, context.storedFileId])
        return { assetId, url }
      },
    })
    res.status(201).json({ ok:true, ...completed.business, storage_provider:completed.provider, upload_phase:'confirmed' })
  } catch (error) {
    const safe = safeStorageError(error, 'storage_confirm_failed')
    res.status(400).json({ ok:false, error:safe.code, code:safe.code, stage:safe.stage, cleanup_pending:!!safe.cleanupPending, upload_phase:'failed' })
  }
})

router.get('/post-images/:assetId/file', async (req, res) => {
  try {
    const asset = await queryOne('SELECT * FROM post_assets WHERE asset_id = ? AND stored_file_id IS NOT NULL', [req.params.assetId])
    if (!asset) return res.status(404).json({ ok:false, error:'图片不存在' })
    const stored = await loadStoredFile(asset.stored_file_id)
    if (!stored) return res.status(404).json({ ok:false, error:'图片文件不存在' })
    const storage = await createStorageService()
    const served = await sendStoredFile({ res, storage, row:stored })
    if (!served && !res.headersSent) res.status(404).json({ ok:false, error:'图片文件不存在' })
  } catch (error) {
    console.error('[Posts] Image read error:', error)
    if (!res.headersSent) res.status(404).json({ ok:false, error:'图片文件不存在' })
  }
})

// Delete post image
router.delete('/post-images', authMiddleware, async (req, res) => {
  try {
    const { id } = req.query
    const asset = await queryOne('SELECT * FROM post_assets WHERE asset_id = ? AND user_id = ?', [id, req.user.id])
    if (asset) {
      if (asset.stored_file_id) {
        const stored = await loadStoredFile(asset.stored_file_id, { includeDeleted:true })
        await withTransaction(async run => {
          await run('DELETE FROM post_assets WHERE asset_id = ? AND user_id = ?', [id, req.user.id])
          await run("UPDATE stored_files SET status = 'deleting', updated_at = NOW() WHERE id = ?", [asset.stored_file_id])
        })
        if (stored && !['deleted', 'failed'].includes(stored.status)) {
          const storage = await createStorageService()
          try { await storage.delete({ provider:stored.storage_provider, objectKey:stored.object_key, configVersion:stored.config_version }) } catch (error) {
            const safe = safeStorageError(error, 'storage_delete_failed')
            return res.status(400).json({ ok:false, error:safe.code, code:safe.code, cleanup_pending:true })
          }
        }
        try { await queryRun("UPDATE stored_files SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = ?", [asset.stored_file_id]) } catch {
          return res.status(400).json({ ok:false, error:'storage_delete_state_pending', code:'storage_delete_state_pending', cleanup_pending:true })
        }
      } else {
        const fileName = String(asset.url || '').replace(/^\/uploads\//, '')
        if (fileName && !fileName.includes('/') && !fileName.includes('\\')) {
          const filePath = join(__uploadDir, fileName)
          try { unlinkSync(filePath) } catch {}
        }
        await queryRun('DELETE FROM post_assets WHERE asset_id = ? AND user_id = ?', [id, req.user.id])
      }
    }
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

export default router
