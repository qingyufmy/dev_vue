import { Router } from 'express'
import { getDB } from '../db.js'
import { authMiddleware, optionalAuth } from '../middleware/auth.js'

const router = Router()

// Get comments for episode
router.get('/comments', optionalAuth, (req, res) => {
  try {
    const { episode } = req.query
    if (!episode) return res.json({ ok: true, comments: [] })

    const db = getDB()
    const comments = db.prepare(`
      SELECT c.*, u.nickname, u.avatar, u.email
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.episode_id = ?
      ORDER BY c.created_at DESC
    `).all(episode)

    // Get replies for each comment
    const result = comments.filter(c => !c.parent_id).map(c => {
      const replies = comments.filter(r => r.parent_id === c.id)
      const liked = req.user ? db.prepare('SELECT id FROM comment_likes WHERE user_id = ? AND comment_id = ?').get(req.user.id, c.id) : null
      return {
        id: c.id,
        text: c.text,
        likes: c.likes,
        liked: Boolean(liked),
        createdAt: c.created_at,
        user: { nickname: c.nickname || '匿名', avatar: c.avatar, email: c.email },
        replies: replies.map(r => ({
          id: r.id,
          text: r.text,
          likes: r.likes,
          createdAt: r.created_at,
          user: { nickname: r.nickname || '匿名', avatar: r.avatar, email: r.email }
        }))
      }
    })

    res.json({ ok: true, comments: result })
  } catch (err) {
    console.error('Comments error:', err)
    res.json({ ok: false, error: '获取评论失败' })
  }
})

// Add comment
router.post('/comments', authMiddleware, (req, res) => {
  try {
    const { episodeId, text, parentId } = req.body
    if (!episodeId || !text?.trim()) {
      return res.json({ ok: false, error: '评论内容不能为空' })
    }

    const db = getDB()
    const result = db.prepare(`
      INSERT INTO comments (episode_id, user_id, text, parent_id) VALUES (?, ?, ?, ?)
    `).run(episodeId, req.user.id, text.trim(), parentId || null)

    // Update reply count if it's a reply
    if (parentId) {
      db.prepare('UPDATE comments SET updated_at = datetime(\'now\') WHERE id = ?').run(parentId)
    }

    const comment = db.prepare(`
      SELECT c.*, u.nickname, u.avatar FROM comments c
      LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?
    `).get(result.lastInsertRowid)

    res.json({
      ok: true,
      comment: {
        id: comment.id,
        text: comment.text,
        likes: 0,
        createdAt: comment.created_at,
        user: { nickname: comment.nickname || '匿名', avatar: comment.avatar },
        replies: []
      }
    })
  } catch (err) {
    console.error('Add comment error:', err)
    res.json({ ok: false, error: '发表评论失败' })
  }
})

// Delete comment
router.delete('/comments', authMiddleware, (req, res) => {
  try {
    const { id } = req.query
    const db = getDB()
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id)
    if (!comment) return res.json({ ok: false, error: '评论不存在' })
    if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.json({ ok: false, error: '无权删除' })
    }

    db.prepare('DELETE FROM comments WHERE id = ? OR parent_id = ?').run(id, id)
    db.prepare('DELETE FROM comment_likes WHERE comment_id = ?').run(id)
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: '删除失败' })
  }
})

// Like/unlike comment
router.post('/comments-like', authMiddleware, (req, res) => {
  try {
    const { commentId } = req.body
    const db = getDB()

    const existing = db.prepare('SELECT id FROM comment_likes WHERE user_id = ? AND comment_id = ?').get(req.user.id, commentId)

    if (existing) {
      db.prepare('DELETE FROM comment_likes WHERE id = ?').run(existing.id)
      db.prepare('UPDATE comments SET likes = MAX(0, likes - 1) WHERE id = ?').run(commentId)
      res.json({ ok: true, liked: false })
    } else {
      db.prepare('INSERT INTO comment_likes (user_id, comment_id) VALUES (?, ?)').run(req.user.id, commentId)
      db.prepare('UPDATE comments SET likes = likes + 1 WHERE id = ?').run(commentId)
      res.json({ ok: true, liked: true })
    }
  } catch (err) {
    res.json({ ok: false, error: '操作失败' })
  }
})

export default router
