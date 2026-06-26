import { Router } from 'express'
import { queryOne, queryAll, queryRun } from '../db.js'
import { authMiddleware, optionalAuth } from '../middleware/auth.js'

const router = Router()

// Get comments for episode
router.get('/comments', optionalAuth, async (req, res) => {
  try {
    const { episode } = req.query
    if (!episode) return res.json({ ok: true, comments: [] })

    const comments = await queryAll(`
      SELECT c.*, u.nickname, u.avatar, u.email
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.episode_id = ?
      ORDER BY c.created_at DESC
    `, [episode])

    // Batch load all user likes for this episode (avoid N+1)
    let likedSet = new Set()
    if (req.user && comments.length > 0) {
      const commentIds = comments.map(c => c.id)
      const placeholders = commentIds.map(() => '?').join(',')
      const likedRows = await queryAll(
        `SELECT comment_id FROM comment_likes WHERE user_id = ? AND comment_id IN (${placeholders})`,
        [req.user.id, ...commentIds]
      )
      likedSet = new Set(likedRows.map(r => r.comment_id))
    }

    // Get replies for each comment
    const result = comments.filter(c => !c.parent_id).map(c => {
      const replies = comments.filter(r => r.parent_id === c.id)
      return {
        id: c.id,
        text: c.text,
        likes: c.likes,
        liked: likedSet.has(c.id),
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
router.post('/comments', authMiddleware, async (req, res) => {
  try {
    const { episodeId, text, parentId } = req.body
    if (!episodeId || !text?.trim()) {
      return res.json({ ok: false, error: '评论内容不能为空' })
    }

    const result = await queryRun(`
      INSERT INTO comments (episode_id, user_id, text, parent_id) VALUES (?, ?, ?, ?)
    `, [episodeId, req.user.id, text.trim(), parentId || null])

    // Update reply count if it's a reply
    if (parentId) {
      await queryRun("UPDATE comments SET updated_at = NOW() WHERE id = ?", [parentId])
    }

    const comment = await queryOne(`
      SELECT c.*, u.nickname, u.avatar FROM comments c
      LEFT JOIN users u ON c.user_id = u.id WHERE c.id = ?
    `, [result.insertId])

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
router.delete('/comments', authMiddleware, async (req, res) => {
  try {
    const { id } = req.query
    const comment = await queryOne('SELECT * FROM comments WHERE id = ?', [id])
    if (!comment) return res.json({ ok: false, error: '评论不存在' })
    if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.json({ ok: false, error: '无权删除' })
    }

    await queryRun('DELETE FROM comments WHERE id = ? OR parent_id = ?', [id, id])
    await queryRun('DELETE FROM comment_likes WHERE comment_id = ?', [id])
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: '删除失败' })
  }
})

// Like/unlike comment
router.post('/comments-like', authMiddleware, async (req, res) => {
  try {
    const { commentId } = req.body

    const existing = await queryOne('SELECT id FROM comment_likes WHERE user_id = ? AND comment_id = ?', [req.user.id, commentId])

    if (existing) {
      await queryRun('DELETE FROM comment_likes WHERE id = ?', [existing.id])
      await queryRun('UPDATE comments SET likes = GREATEST(0, likes - 1) WHERE id = ?', [commentId])
      res.json({ ok: true, liked: false })
    } else {
      await queryRun('INSERT INTO comment_likes (user_id, comment_id) VALUES (?, ?)', [req.user.id, commentId])
      await queryRun('UPDATE comments SET likes = likes + 1 WHERE id = ?', [commentId])
      res.json({ ok: true, liked: true })
    }
  } catch (err) {
    res.json({ ok: false, error: '操作失败' })
  }
})

export default router
