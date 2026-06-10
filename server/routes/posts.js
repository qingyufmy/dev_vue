import { Router } from 'express'
import { getDB } from '../db.js'
import { authMiddleware, optionalAuth } from '../middleware/auth.js'

const router = Router()

// Get posts (list or single)
router.get('/posts', optionalAuth, (req, res) => {
  try {
    const { id, board, category, search, q, tag, sort, page = 1, limit = 20 } = req.query
    const db = getDB()

    // Single post
    if (id) {
      const post = db.prepare(`
        SELECT p.*, u.nickname, u.avatar, u.email, u.role as user_role,
               ru.nickname as reply_user_name, ru.avatar as reply_user_avatar
        FROM posts p LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN users ru ON p.last_reply_user_id = ru.id
        WHERE p.id = ?
      `).get(id)
      if (!post) return res.json({ ok: false, error: '帖子不存在' })

      db.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').run(id)

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
          contentHtml: post.content_html || post.content || '',
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
            email: post.email,
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
      where += " AND p.tags LIKE ?"
      params.push(`%"${tag}"%`)
    }

    const offset = (Number(page) - 1) * Number(limit)
    const total = db.prepare(`SELECT COUNT(*) as c FROM posts p WHERE ${where}`).get(...params).c

    let orderBy = 'p.pinned DESC, '
    if (sort === 'newest') orderBy += 'p.created_at DESC'
    else if (sort === 'hot') orderBy += 'p.view_count DESC'
    else orderBy += 'COALESCE(p.last_reply_at, p.created_at) DESC'

    const posts = db.prepare(`
      SELECT p.*, u.nickname, u.avatar, u.email, u.role as user_role,
             ru.nickname as reply_user_name, ru.avatar as reply_user_avatar
      FROM posts p LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN users ru ON p.last_reply_user_id = ru.id
      WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `).all(...params, Number(limit), offset)

    // Get tags
    const availableTags = db.prepare('SELECT * FROM post_tags ORDER BY count DESC LIMIT 20').all()

    // Get participants for each post
    const postIds = posts.map(p => p.id)
    const participants = {}
    if (postIds.length) {
      const placeholders = postIds.map(() => '?').join(',')
      const parts = db.prepare(`
        SELECT pr.post_id, u.nickname, u.avatar FROM post_replies pr
        LEFT JOIN users u ON pr.user_id = u.id
        WHERE pr.post_id IN (${placeholders})
        GROUP BY pr.post_id, pr.user_id
        ORDER BY MAX(pr.created_at) DESC
      `).all(...postIds)
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
          user: { id: p.user_id, name: p.nickname || '匿名', avatar: p.avatar, email: p.email, isAdmin: p.user_role === 'admin' },
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
router.post('/posts', authMiddleware, (req, res) => {
  try {
    const { title, content, contentHtml, contentText, board, category, images, tags, assetIds } = req.body
    if (!title?.trim()) return res.json({ ok: false, error: '标题不能为空' })

    const db = getDB()
    const tagStr = typeof tags === 'string' ? JSON.stringify(tags.split(',').map(t => t.trim()).filter(Boolean)) : JSON.stringify(tags || [])
    const imageArr = Array.isArray(images) ? images : []
    const assetArr = Array.isArray(assetIds) ? assetIds : []

    const result = db.prepare(`
      INSERT INTO posts (user_id, board, title, content, content_html, content_text, category, tags, images, asset_ids, image_count, last_reply_at, last_reply_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(req.user.id, board || 'ideas', title.trim(), contentHtml || contentText || content || '', contentHtml || '', contentText || '', category || 'general', tagStr, JSON.stringify(imageArr), JSON.stringify(assetArr), imageArr.length, req.user.id)

    // Update tag counts
    const tagList = typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean) : (tags || [])
    for (const t of tagList) {
      const slug = t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '-')
      db.prepare('INSERT INTO post_tags (slug, label, count) VALUES (?, ?, 1) ON CONFLICT(slug) DO UPDATE SET count = count + 1').run(slug, t)
    }

    res.json({ ok: true, success: true, postId: result.lastInsertRowid })
  } catch (err) {
    console.error('Create post error:', err)
    res.json({ ok: false, error: '发帖失败' })
  }
})

// Update post
router.put('/posts', authMiddleware, (req, res) => {
  try {
    const { id, title, content, category } = req.body
    const db = getDB()
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id)
    if (!post) return res.json({ ok: false, error: '帖子不存在' })
    if (post.user_id !== req.user.id && req.user.role !== 'admin') return res.json({ ok: false, error: '无权编辑' })

    db.prepare("UPDATE posts SET title = ?, content = ?, category = ?, updated_at = datetime('now') WHERE id = ?").run(title || post.title, content || post.content, category || post.category, id)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '编辑失败' }) }
})

// Delete post
router.delete('/posts', authMiddleware, (req, res) => {
  try {
    const { id } = req.query
    const db = getDB()
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id)
    if (!post) return res.json({ ok: false, error: '帖子不存在' })
    if (post.user_id !== req.user.id && req.user.role !== 'admin') return res.json({ ok: false, error: '无权删除' })

    db.prepare('DELETE FROM posts WHERE id = ?').run(id)
    db.prepare('DELETE FROM post_replies WHERE post_id = ?').run(id)
    res.json({ ok: true, success: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

// Pin/feature/lock (PATCH)
router.patch('/posts/pin', authMiddleware, (req, res) => {
  try {
    const { postId, sticky } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()
    db.prepare('UPDATE posts SET pinned = ? WHERE id = ?').run(sticky ? 1 : 0, postId)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.patch('/posts/feature', authMiddleware, (req, res) => {
  try {
    const { postId, featured } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()
    db.prepare('UPDATE posts SET featured = ? WHERE id = ?').run(featured ? 1 : 0, postId)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.patch('/posts/lock', authMiddleware, (req, res) => {
  try {
    const { postId, locked } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()
    db.prepare('UPDATE posts SET locked = ? WHERE id = ?').run(locked ? 1 : 0, postId)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

// Also support POST for pin/feature/lock (frontend uses both)
router.post('/posts/pin', authMiddleware, (req, res) => {
  try {
    const { postId, sticky } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()
    const post = db.prepare('SELECT pinned FROM posts WHERE id = ?').get(postId)
    db.prepare('UPDATE posts SET pinned = ? WHERE id = ?').run(post?.pinned ? 0 : 1, postId)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.post('/posts/feature', authMiddleware, (req, res) => {
  try {
    const { postId } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()
    const post = db.prepare('SELECT featured FROM posts WHERE id = ?').get(postId)
    db.prepare('UPDATE posts SET featured = ? WHERE id = ?').run(post?.featured ? 0 : 1, postId)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.post('/posts/lock', authMiddleware, (req, res) => {
  try {
    const { postId } = req.body
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()
    const post = db.prepare('SELECT locked FROM posts WHERE id = ?').get(postId)
    db.prepare('UPDATE posts SET locked = ? WHERE id = ?').run(post?.locked ? 0 : 1, postId)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

// Get post replies
router.get('/post-replies', optionalAuth, (req, res) => {
  try {
    const { post, page = 1 } = req.query
    const db = getDB()
    const limit = 20
    const offset = (Number(page) - 1) * limit

    const replies = db.prepare(`
      SELECT r.*, u.nickname, u.avatar, u.email, u.role as user_role,
             q.content as quote_content, q.user_id as quote_user_id, qu.nickname as quote_user_name,
             q.floor_number as quote_floor_number
      FROM post_replies r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN post_replies q ON r.quote_reply_id = q.id
      LEFT JOIN users qu ON q.user_id = qu.id
      WHERE r.post_id = ? ORDER BY r.created_at ASC LIMIT ? OFFSET ?
    `).all(post, limit, offset)

    const total = db.prepare('SELECT COUNT(*) as c FROM post_replies WHERE post_id = ?').get(post).c

    res.json({
      ok: true,
      success: true,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / limit),
      replies: replies.map(r => ({
        id: r.id,
        content: r.content_html || r.content,
        contentText: r.content_text || r.content,
        contentHtml: r.content_html || '',
        floorNumber: r.floor_number || 0,
        images: JSON.parse(r.images || '[]'),
        likes: r.likes,
        createdAt: r.created_at,
        user: { id: r.user_id, name: r.nickname || '匿名', avatar: r.avatar, email: r.email, isAdmin: r.user_role === 'admin' },
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
router.post('/post-replies', authMiddleware, (req, res) => {
  try {
    const { postId, content, contentHtml, contentText, quoteReplyId, assetIds } = req.body
    if (!postId) return res.json({ ok: false, error: '缺少帖子ID' })
    if (!content?.trim() && !contentHtml && !contentText) return res.json({ ok: false, error: '回复内容不能为空' })

    const db = getDB()
    const post = db.prepare('SELECT locked FROM posts WHERE id = ?').get(postId)
    if (post?.locked) return res.json({ ok: false, error: '帖子已锁定' })

    // Get floor number
    const maxFloor = db.prepare('SELECT MAX(floor_number) as m FROM post_replies WHERE post_id = ?').get(postId).m || 0

    const result = db.prepare(`
      INSERT INTO post_replies (post_id, user_id, content, content_html, content_text, asset_ids, quote_reply_id, floor_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(postId, req.user.id, contentHtml || contentText || content?.trim() || '', contentHtml || '', contentText || content?.trim() || '', JSON.stringify(assetIds || []), quoteReplyId || null, maxFloor + 1)

    db.prepare("UPDATE posts SET reply_count = reply_count + 1, last_reply_at = datetime('now', '+8 hours'), last_reply_user_id = ? WHERE id = ?").run(req.user.id, postId)

    // Create notification for post author
    const postAuthor = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(postId)
    if (postAuthor && postAuthor.user_id !== req.user.id) {
      db.prepare(`
        INSERT INTO notifications (user_id, actor_id, type, title, message, post_id, meta)
        VALUES (?, ?, 'reply', '你的帖子有了新回复', ?, ?, ?)
      `).run(postAuthor.user_id, req.user.id, `${req.user.nickname || '匿名用户'}回复了你的帖子`, postId, JSON.stringify({ excerpt: (content || '').substring(0, 100) }))
    }

    // Create notification for quoted reply author
    if (quoteReplyId) {
      const quotedReply = db.prepare('SELECT user_id FROM post_replies WHERE id = ?').get(quoteReplyId)
      if (quotedReply && quotedReply.user_id !== req.user.id && quotedReply.user_id !== postAuthor?.user_id) {
        db.prepare(`
          INSERT INTO notifications (user_id, actor_id, type, title, message, post_id, meta)
          VALUES (?, ?, 'reply_quote', '有人引用了你的回复', ?, ?, ?)
        `).run(quotedReply.user_id, req.user.id, `${req.user.nickname || '匿名用户'}引用了你的回复`, postId, JSON.stringify({ excerpt: (content || '').substring(0, 100) }))
      }
    }

    res.json({ ok: true, success: true, replyId: result.lastInsertRowid })
  } catch (err) {
    console.error('Add reply error:', err)
    res.json({ ok: false, error: '回复失败' })
  }
})

// Delete reply
router.delete('/post-replies', authMiddleware, (req, res) => {
  try {
    const { id } = req.query
    const db = getDB()
    const reply = db.prepare('SELECT * FROM post_replies WHERE id = ?').get(id)
    if (!reply) return res.json({ ok: false, error: '回复不存在' })
    if (reply.user_id !== req.user.id && req.user.role !== 'admin') return res.json({ ok: false, error: '无权删除' })

    db.prepare('DELETE FROM post_replies WHERE id = ?').run(id)
    db.prepare('UPDATE posts SET reply_count = MAX(0, reply_count - 1) WHERE id = ?').run(reply.post_id)
    res.json({ ok: true, success: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

// Report
router.post('/post-reports', authMiddleware, (req, res) => {
  try {
    const { postId, replyId, reason, detail } = req.body
    const db = getDB()
    db.prepare('INSERT INTO post_reports (post_id, reply_id, user_id, reason, detail) VALUES (?, ?, ?, ?, ?)').run(postId || null, replyId || null, req.user.id, reason || '', detail || '')
    res.json({ ok: true, message: '举报已提交' })
  } catch (err) { res.json({ ok: false, error: '举报失败' }) }
})

router.get('/post-reports', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
    const db = getDB()
    const reports = db.prepare('SELECT r.*, u.nickname as reporter_name FROM post_reports r LEFT JOIN users u ON r.user_id = u.id ORDER BY r.created_at DESC LIMIT 100').all()
    res.json({ ok: true, reports })
  } catch (err) { res.json({ ok: false, error: '获取举报失败' }) }
})

// Post images upload
router.post('/post-images', authMiddleware, (req, res) => {
  try {
    // For local dev, return a placeholder
    const assetId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const url = `/uploads/${assetId}.jpg`

    const db = getDB()
    db.prepare('INSERT INTO post_assets (asset_id, user_id, url) VALUES (?, ?, ?)').run(assetId, req.user.id, url)

    res.json({ ok: true, assetId, url })
  } catch (err) { res.json({ ok: false, error: '上传失败' }) }
})

// Delete post image
router.delete('/post-images', authMiddleware, (req, res) => {
  try {
    const { id } = req.query
    const db = getDB()
    db.prepare('DELETE FROM post_assets WHERE asset_id = ? AND user_id = ?').run(id, req.user.id)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

export default router
