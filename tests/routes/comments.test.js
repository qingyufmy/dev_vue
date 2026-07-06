import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
}))
vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, res, next) => next()),
  optionalAuth: vi.fn((req, res, next) => next()),
}))

import { queryOne, queryAll, queryRun } from '../../server/db.js'
import commentsRouter from '../../server/routes/comments.js'

function callRoute(method, path, body = {}, user = null) {
  return new Promise((resolve) => {
    const req = { method, path, body, params: {}, query: body, user, ip: '127.0.0.1', get: () => 'test' }
    let jsonData = null, statusCode = 200
    const res = {
      status: (c) => { statusCode = c; return res },
      json: (d) => { jsonData = d; resolve({ json: jsonData, status: statusCode }) },
    }
    const next = vi.fn()
    const layer = commentsRouter.stack.find(l => l.route && l.route.path === path && l.route.methods[method])
    if (layer) {
      layer.handle(req, res, next)
    } else {
      resolve({ json: { error: 'route not found' }, status: 404 })
    }
  })
}

describe('comments.js — GET /comments', () => {
  beforeEach(() => {
    queryOne.mockReset()
    queryAll.mockReset()
    queryRun.mockReset()
  })

  it('缺少 episode 参数返回空评论列表', async () => {
    const { json } = await callRoute('get', '/comments', {})
    expect(json).toMatchObject({ ok: true, comments: [] })
    expect(queryAll).not.toHaveBeenCalled()
  })

  it('返回剧集评论列表', async () => {
    queryAll
      .mockResolvedValueOnce([
        { id: 1, episode_id: 'ep1', user_id: 10, text: '好看', likes: 5, parent_id: null, created_at: '2026-01-01', nickname: '用户A', avatar: 'a.png', email: 'a@test.com' },
        { id: 2, episode_id: 'ep1', user_id: 11, text: '回复', likes: 1, parent_id: 1, created_at: '2026-01-02', nickname: '用户B', avatar: 'b.png', email: 'b@test.com' },
      ])

    const { json } = await callRoute('get', '/comments', { episode: 'ep1' })
    expect(json.ok).toBe(true)
    expect(json.comments).toHaveLength(1)
    expect(json.comments[0].id).toBe(1)
    expect(json.comments[0].replies).toHaveLength(1)
    expect(json.comments[0].replies[0].text).toBe('回复')
  })

  it('未登录用户评论 liked 为 false', async () => {
    queryAll
      .mockResolvedValueOnce([
        { id: 1, episode_id: 'ep1', user_id: 10, text: '好', likes: 0, parent_id: null, created_at: '2026-01-01', nickname: null, avatar: null, email: null },
      ])

    const { json } = await callRoute('get', '/comments', { episode: 'ep1' }, null)
    expect(json.ok).toBe(true)
    expect(json.comments[0].liked).toBe(false)
    expect(json.comments[0].user.nickname).toBe('匿名')
  })

  it('登录用户评论 liked 根据 comment_likes 判断', async () => {
    queryAll
      .mockResolvedValueOnce([
        { id: 1, episode_id: 'ep1', user_id: 10, text: '好', likes: 3, parent_id: null, created_at: '2026-01-01', nickname: 'A', avatar: null, email: null },
        { id: 2, episode_id: 'ep1', user_id: 11, text: '赞', likes: 0, parent_id: null, created_at: '2026-01-01', nickname: 'B', avatar: null, email: null },
      ])
      .mockResolvedValueOnce([{ comment_id: 1 }])

    const { json } = await callRoute('get', '/comments', { episode: 'ep1' }, { id: 99 })
    expect(json.comments[0].liked).toBe(true)
    expect(json.comments[1].liked).toBe(false)
  })

  it('数据库异常返回错误', async () => {
    queryAll.mockRejectedValueOnce(new Error('db fail'))
    const { json } = await callRoute('get', '/comments', { episode: 'ep1' })
    expect(json).toMatchObject({ ok: false, error: '获取评论失败' })
  })
})

describe('comments.js — POST /comments', () => {
  beforeEach(() => {
    queryOne.mockReset()
    queryAll.mockReset()
    queryRun.mockReset()
  })

  it('缺少 episodeId 返回错误', async () => {
    const { json } = await callRoute('post', '/comments', { text: '内容' }, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '评论内容不能为空' })
  })

  it('缺少 text 返回错误', async () => {
    const { json } = await callRoute('post', '/comments', { episodeId: 'ep1' }, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '评论内容不能为空' })
  })

  it('text 只有空格返回错误', async () => {
    const { json } = await callRoute('post', '/comments', { episodeId: 'ep1', text: '   ' }, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '评论内容不能为空' })
  })

  it('成功创建评论', async () => {
    queryRun.mockResolvedValueOnce({ insertId: 100 })
    queryOne.mockResolvedValueOnce({
      id: 100, text: '好看', created_at: '2026-01-01', nickname: '测试用户', avatar: 'ava.png',
    })

    const { json } = await callRoute('post', '/comments', {
      episodeId: 'ep1', text: '好看',
    }, { id: 1 })

    expect(json.ok).toBe(true)
    expect(json.comment.id).toBe(100)
    expect(json.comment.text).toBe('好看')
    expect(json.comment.likes).toBe(0)
    expect(json.comment.user.nickname).toBe('测试用户')
  })

  it('回复评论时更新父评论 updated_at', async () => {
    queryRun.mockResolvedValueOnce({ insertId: 101 })
    queryRun.mockResolvedValueOnce()
    queryOne.mockResolvedValueOnce({
      id: 101, text: '回复', created_at: '2026-01-01', nickname: null, avatar: null,
    })

    const { json } = await callRoute('post', '/comments', {
      episodeId: 'ep1', text: '回复', parentId: 50,
    }, { id: 1 })

    expect(json.ok).toBe(true)
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE comments SET updated_at'),
      [50]
    )
  })

  it('数据库异常返回错误', async () => {
    queryRun.mockRejectedValueOnce(new Error('db fail'))
    const { json } = await callRoute('post', '/comments', {
      episodeId: 'ep1', text: '内容',
    }, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '发表评论失败' })
  })
})

describe('comments.js — DELETE /comments', () => {
  beforeEach(() => {
    queryOne.mockReset()
    queryAll.mockReset()
    queryRun.mockReset()
  })

  it('评论不存在返回错误', async () => {
    queryOne.mockResolvedValueOnce(null)
    const { json } = await callRoute('delete', '/comments', { id: 999 }, { id: 1, role: 'free' })
    expect(json).toMatchObject({ ok: false, error: '评论不存在' })
  })

  it('非本人且非管理员无法删除', async () => {
    queryOne.mockResolvedValueOnce({ id: 999, user_id: 10 })
    const { json } = await callRoute('delete', '/comments', { id: 999 }, { id: 1, role: 'free' })
    expect(json).toMatchObject({ ok: false, error: '无权删除' })
  })

  it('本人可以删除自己的评论', async () => {
    queryOne.mockResolvedValueOnce({ id: 10, user_id: 1 })
    queryRun.mockResolvedValueOnce()
    queryRun.mockResolvedValueOnce()
    const { json } = await callRoute('delete', '/comments', { id: 10 }, { id: 1, role: 'free' })
    expect(json).toMatchObject({ ok: true })
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM comments'),
      [10, 10]
    )
  })

  it('管理员可以删除任意评论', async () => {
    queryOne.mockResolvedValueOnce({ id: 10, user_id: 50 })
    queryRun.mockResolvedValueOnce()
    queryRun.mockResolvedValueOnce()
    const { json } = await callRoute('delete', '/comments', { id: 10 }, { id: 1, role: 'admin' })
    expect(json).toMatchObject({ ok: true })
  })

  it('删除时清理 comment_likes', async () => {
    queryOne.mockResolvedValueOnce({ id: 10, user_id: 1 })
    queryRun.mockResolvedValueOnce()
    queryRun.mockResolvedValueOnce()
    await callRoute('delete', '/comments', { id: 10 }, { id: 1, role: 'free' })
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM comment_likes'),
      [10]
    )
  })

  it('数据库异常返回错误', async () => {
    queryOne.mockRejectedValueOnce(new Error('db fail'))
    const { json } = await callRoute('delete', '/comments', { id: 10 }, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '删除失败' })
  })
})

describe('comments.js — POST /comments-like', () => {
  beforeEach(() => {
    queryOne.mockReset()
    queryAll.mockReset()
    queryRun.mockReset()
  })

  it('点赞评论', async () => {
    queryOne.mockResolvedValueOnce(null)
    queryRun.mockResolvedValueOnce()
    queryRun.mockResolvedValueOnce()

    const { json } = await callRoute('post', '/comments-like', { commentId: 10 }, { id: 1 })
    expect(json).toMatchObject({ ok: true, liked: true })
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO comment_likes'),
      [1, 10]
    )
  })

  it('取消点赞', async () => {
    queryOne.mockResolvedValueOnce({ id: 42 })
    queryRun.mockResolvedValueOnce()
    queryRun.mockResolvedValueOnce()

    const { json } = await callRoute('post', '/comments-like', { commentId: 10 }, { id: 1 })
    expect(json).toMatchObject({ ok: true, liked: false })
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM comment_likes'),
      [42]
    )
  })

  it('数据库异常返回错误', async () => {
    queryOne.mockRejectedValueOnce(new Error('db fail'))
    const { json } = await callRoute('post', '/comments-like', { commentId: 10 }, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '操作失败' })
  })
})
