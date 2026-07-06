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
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs')
  return { ...actual, mkdirSync: vi.fn() }
})

import { queryOne, queryAll, queryRun } from '../../server/db.js'
import postsRouter from '../../server/routes/posts.js'

function callRoute(method, path, body = {}, user = null) {
  return new Promise((resolve) => {
    const req = {
      method, path, body, params: {},
      query: body, user, ip: '127.0.0.1',
      get: () => 'test', file: null,
    }
    let jsonData = null, statusCode = 200
    const res = {
      status: (c) => { statusCode = c; return res },
      json: (data) => { jsonData = data; resolve({ status: statusCode, json: data }); return res },
    }
    const next = vi.fn()
    const layer = postsRouter.stack.find(l =>
      l.route && l.route.path === path && l.route.methods[method]
    )
    if (layer) layer.handle(req, res, next)
    else resolve({ status: 404, json: { error: 'route not found' } })
  })
}

// ── sanitizeContentHtml ──────────────────────────────────────────

describe('sanitizeContentHtml', () => {
  let sanitize

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../../server/routes/posts.js')
    sanitize = mod.sanitizeContentHtml
  })

  describe('strips dangerous tags', () => {
    it('removes <script> tag and content', () => {
      expect(sanitize('hello<script>alert("xss")</script>world'))
        .toBe('helloworld')
    })

    it('removes <style> tag and content', () => {
      expect(sanitize('a<style>body{display:none}</style>b'))
        .toBe('ab')
    })

    it('removes <iframe> tag and content', () => {
      expect(sanitize('x<iframe src="evil.com"></iframe>y'))
        .toBe('xy')
    })

    it('removes <object> tag and content', () => {
      expect(sanitize('a<object data="bad.swf"></object>b'))
        .toBe('ab')
    })

    it('removes <embed> tag and content', () => {
      expect(sanitize('a<embed src="bad.swf">b'))
        .toBe('ab')
    })

    it('removes <form> tag and content', () => {
      expect(sanitize('a<form action="/steal"><input></form>b'))
        .toBe('ab')
    })

    it('removes self-closing dangerous tags', () => {
      expect(sanitize('a<meta http-equiv="refresh" content="0;url=evil">b'))
        .toBe('ab')
    })

    it('removes <input> tag', () => {
      expect(sanitize('a<input type="text">b')).toBe('ab')
    })

    it('removes <textarea> tag', () => {
      expect(sanitize('a<textarea>bad</textarea>b')).toBe('ab')
    })

    it('removes <button> tag', () => {
      expect(sanitize('a<button onclick="hack()">click</button>b'))
        .toBe('ab')
    })

    it('removes <base> tag', () => {
      expect(sanitize('a<base href="http://evil.com/">b')).toBe('ab')
    })

    it('removes <link> tag', () => {
      expect(sanitize('a<link rel="stylesheet" href="bad.css">b'))
        .toBe('ab')
    })
  })

  describe('strips event handlers', () => {
    it('removes onclick attribute', () => {
      const input = '<div onclick="alert(1)">text</div>'
      const result = sanitize(input)
      expect(result).not.toContain('onclick')
      expect(result).toContain('text')
    })

    it('removes onerror with single-quoted value', () => {
      const input = '<img src=x onerror=\'alert(1)\'>'
      expect(sanitize(input)).not.toContain('onerror')
    })

    it('removes onload with unquoted value', () => {
      const input = '<body onload=alert(1)>'
      expect(sanitize(input)).not.toContain('onload')
    })

    it('removes onmouseover', () => {
      const input = '<div onmouseover="hack()">hover</div>'
      const result = sanitize(input)
      expect(result).not.toContain('onmouseover')
      expect(result).toContain('hover')
    })

    it('strips data-onclick (non-whitelisted data-* attr)', () => {
      const input = '<div data-onclick="value">safe</div>'
      const result = sanitize(input)
      expect(result).not.toContain('data-onclick')
      expect(result).toContain('safe')
    })
  })

  describe('strips javascript: URLs', () => {
    it('replaces javascript: in href', () => {
      const input = '<a href="javascript:alert(1)">click</a>'
      const result = sanitize(input)
      expect(result).not.toContain('javascript:')
      expect(result).toContain('href="#"')
      expect(result).toContain('click')
    })

    it('replaces javascript: in src', () => {
      const input = '<img src="javascript:alert(1)">'
      expect(sanitize(input)).not.toContain('javascript:')
    })

    it('handles single-quoted javascript: URL', () => {
      const input = "<a href='javascript:void(0)'>link</a>"
      expect(sanitize(input)).not.toContain('javascript:')
    })

    it('handles unquoted javascript: URL', () => {
      const input = '<a href=javascript:alert(1)>link</a>'
      expect(sanitize(input)).not.toContain('javascript:')
    })
  })

  describe('preserves safe HTML', () => {
    it('keeps <p> tags', () => {
      expect(sanitize('<p>hello</p>')).toBe('<p>hello</p>')
    })

    it('keeps <strong> tags', () => {
      expect(sanitize('<strong>bold</strong>')).toBe('<strong>bold</strong>')
    })

    it('keeps <em> tags', () => {
      expect(sanitize('<em>italic</em>')).toBe('<em>italic</em>')
    })

    it('keeps <img> with safe src', () => {
      expect(sanitize('<img src="/uploads/test.jpg" alt="pic">'))
        .toBe('<img src="/uploads/test.jpg" alt="pic">')
    })

    it('keeps <a> with safe href', () => {
      expect(sanitize('<a href="https://example.com">link</a>'))
        .toBe('<a href="https://example.com">link</a>')
    })

    it('keeps <br> tags', () => {
      expect(sanitize('line1<br>line2')).toBe('line1<br>line2')
    })

    it('keeps mixed safe tags', () => {
      const html = '<p><strong>bold</strong> and <em>italic</em></p>'
      expect(sanitize(html)).toBe(html)
    })
  })

  describe('edge cases', () => {
    it('returns empty string for null', () => {
      expect(sanitize(null)).toBe('')
    })

    it('returns empty string for undefined', () => {
      expect(sanitize(undefined)).toBe('')
    })

    it('returns empty string for empty string', () => {
      expect(sanitize('')).toBe('')
    })

    it('returns empty string for non-string input', () => {
      expect(sanitize(123)).toBe('')
    })

    it('returns plain text unchanged', () => {
      expect(sanitize('hello world')).toBe('hello world')
    })

    it('preserves data-* attributes in whitelist', () => {
      expect(sanitize('<div data-post-id="1">text</div>'))
        .toContain('data-post-id="1"')
    })

    it('strips non-whitelisted data-* attributes', () => {
      const result = sanitize('<div data-evil="hack">text</div>')
      expect(result).not.toContain('data-evil')
      expect(result).toContain('text')
    })
  })
})

// ── GET /posts (list) ────────────────────────────────────────────

describe('GET /posts — list', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns paginated posts with available tags', async () => {
    queryOne.mockResolvedValueOnce({ c: 1 })
    queryAll
      .mockResolvedValueOnce([{
        id: 1, board: 'ideas', title: 'Test Post',
        content_text: 'Body text', tags: '["tag1"]',
        images: '[]', pinned: 0, featured: 0, locked: 0,
        reply_count: 2, view_count: 10, image_count: 0,
        created_at: '2026-01-01', last_reply_at: null,
        user_id: 1, nickname: 'Alice', avatar: null,
        email: 'a@b.com', user_role: 'user',
        reply_user_name: null, reply_user_avatar: null,
      }])
      .mockResolvedValueOnce([{ slug: 'tag1', label: 'Tag1', count: 5 }])
      .mockResolvedValueOnce([])

    const { json } = await callRoute('get', '/posts', { page: 1, limit: 20 })

    expect(json.ok).toBe(true)
    expect(json.total).toBe(1)
    expect(json.totalPages).toBe(1)
    expect(json.posts).toHaveLength(1)
    expect(json.posts[0].title).toBe('Test Post')
    expect(json.posts[0].tags).toEqual([{ slug: 'tag1', label: 'tag1' }])
    expect(json.posts[0].canDelete).toBeFalsy()
    expect(json.availableTags).toHaveLength(1)
  })

  it('filters by board', async () => {
    queryOne.mockResolvedValueOnce({ c: 0 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await callRoute('get', '/posts', { board: 'trading' })
    const sql = queryOne.mock.calls[0][0]
    expect(sql).toContain('p.board = ?')
  })

  it('filters by category', async () => {
    queryOne.mockResolvedValueOnce({ c: 0 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await callRoute('get', '/posts', { category: 'tech' })
    const sql = queryOne.mock.calls[0][0]
    expect(sql).toContain('p.category = ?')
  })

  it('ignores category=all', async () => {
    queryOne.mockResolvedValueOnce({ c: 0 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await callRoute('get', '/posts', { category: 'all' })
    const sql = queryOne.mock.calls[0][0]
    expect(sql).not.toContain('p.category = ?')
  })

  it('filters by search term', async () => {
    queryOne.mockResolvedValueOnce({ c: 0 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await callRoute('get', '/posts', { search: 'bitcoin' })
    const sql = queryOne.mock.calls[0][0]
    expect(sql).toContain('LIKE')
  })

  it('filters by tag', async () => {
    queryOne.mockResolvedValueOnce({ c: 0 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await callRoute('get', '/posts', { tag: 'crypto' })
    const sql = queryOne.mock.calls[0][0]
    expect(sql).toContain('p.tags LIKE ?')
  })

  it('sort=hot orders by view_count', async () => {
    queryOne.mockResolvedValueOnce({ c: 0 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await callRoute('get', '/posts', { sort: 'hot' })
    const sql = queryAll.mock.calls[0][0]
    expect(sql).toContain('view_count DESC')
  })

  it('sort=newest orders by created_at', async () => {
    queryOne.mockResolvedValueOnce({ c: 0 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])

    await callRoute('get', '/posts', { sort: 'newest' })
    const sql = queryAll.mock.calls[0][0]
    expect(sql).toContain('created_at DESC')
  })

  it('shows canDelete=true for author', async () => {
    queryOne.mockResolvedValueOnce({ c: 1 })
    queryAll
      .mockResolvedValueOnce([{
        id: 5, board: 'ideas', title: 'Mine',
        content_text: 'text', tags: '[]', images: '[]',
        pinned: 0, featured: 0, locked: 0,
        reply_count: 0, view_count: 1, image_count: 0,
        created_at: '2026-01-01', last_reply_at: null,
        user_id: 42, nickname: 'Bob', avatar: null,
        email: 'b@b.com', user_role: 'user',
        reply_user_name: null, reply_user_avatar: null,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const { json } = await callRoute('get', '/posts', {}, { id: 42, role: 'user' })
    expect(json.posts[0].canDelete).toBe(true)
  })

  it('shows canModerate=true for admin', async () => {
    queryOne.mockResolvedValueOnce({ c: 1 })
    queryAll
      .mockResolvedValueOnce([{
        id: 6, board: 'ideas', title: 'Any',
        content_text: 'text', tags: '[]', images: '[]',
        pinned: 0, featured: 0, locked: 0,
        reply_count: 0, view_count: 1, image_count: 0,
        created_at: '2026-01-01', last_reply_at: null,
        user_id: 1, nickname: 'Admin', avatar: null,
        email: 'a@a.com', user_role: 'admin',
        reply_user_name: null, reply_user_avatar: null,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const { json } = await callRoute('get', '/posts', {}, { id: 1, role: 'admin' })
    expect(json.posts[0].canModerate).toBe(true)
  })

  it('handles error gracefully', async () => {
    queryOne.mockRejectedValueOnce(new Error('db fail'))
    const { json } = await callRoute('get', '/posts', {})
    expect(json.ok).toBe(false)
    expect(json.error).toBe('获取帖子失败')
  })
})

// ── GET /posts (single) ──────────────────────────────────────────

describe('GET /posts — single post', () => {
  beforeEach(() => vi.clearAllMocks())

  const mockPost = {
    id: 1, board: 'ideas', title: 'My Post',
    content: 'fallback', content_html: '<p>Rich</p>',
    content_text: 'Plain text', tags: '["alpha","beta"]',
    images: '["/uploads/a.jpg"]', pinned: 1, featured: 1,
    locked: 0, reply_count: 5, view_count: 20,
    image_count: 1, created_at: '2026-03-01',
    last_reply_at: '2026-03-05', last_reply_user_id: 3,
    user_id: 1, nickname: 'Alice', avatar: 'av.png',
    email: 'a@b.com', user_role: 'admin',
    reply_user_name: 'Bob', reply_user_avatar: 'bob.png',
  }

  it('returns full post data with incremented view count', async () => {
    queryOne.mockResolvedValueOnce(mockPost)
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('get', '/posts', { id: 1 })

    expect(json.ok).toBe(true)
    expect(json.post.id).toBe(1)
    expect(json.post.title).toBe('My Post')
    expect(json.post.contentHtml).toBe('<p>Rich</p>')
    expect(json.post.contentText).toBe('Plain text')
    expect(json.post.contentFormat).toBe('rich')
    expect(json.post.pinned).toBe(true)
    expect(json.post.isSticky).toBe(true)
    expect(json.post.featured).toBe(true)
    expect(json.post.isFeatured).toBe(true)
    expect(json.post.viewCount).toBe(21)
    expect(json.post.replyCount).toBe(5)
    expect(json.post.tags).toEqual([
      { slug: 'alpha', label: 'alpha' },
      { slug: 'beta', label: 'beta' },
    ])
    expect(json.post.images).toEqual(['/uploads/a.jpg'])
    expect(json.post.user.name).toBe('Alice')
    expect(json.post.user.isAdmin).toBe(true)
    expect(json.post.lastReplyUser).toEqual({ name: 'Bob', avatar: 'bob.png' })
  })

  it('increments view_count in database', async () => {
    queryOne.mockResolvedValueOnce(mockPost)
    queryRun.mockResolvedValueOnce({})

    await callRoute('get', '/posts', { id: 1 })
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('view_count + 1'),
      [1]
    )
  })

  it('returns error for non-existent post', async () => {
    queryOne.mockResolvedValueOnce(null)

    const { json } = await callRoute('get', '/posts', { id: 999 })
    expect(json.ok).toBe(false)
    expect(json.error).toBe('帖子不存在')
  })

  it('sets contentFormat to plain when no content_html', async () => {
    const plainPost = { ...mockPost, content_html: null }
    queryOne.mockResolvedValueOnce(plainPost)
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('get', '/posts', { id: 1 })
    expect(json.post.contentFormat).toBe('plain')
  })

  it('canDelete=true for author', async () => {
    queryOne.mockResolvedValueOnce(mockPost)
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('get', '/posts', { id: 1 },
      { id: 1, role: 'user' })
    expect(json.post.canDelete).toBe(true)
  })

  it('canDelete=false for non-author non-admin', async () => {
    queryOne.mockResolvedValueOnce(mockPost)
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('get', '/posts', { id: 1 },
      { id: 99, role: 'user' })
    expect(json.post.canDelete).toBe(false)
  })

  it('returns null lastReplyUser when no reply user', async () => {
    const noReply = { ...mockPost, reply_user_name: null }
    queryOne.mockResolvedValueOnce(noReply)
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('get', '/posts', { id: 1 })
    expect(json.post.lastReplyUser).toBeNull()
  })

  it('defaults nickname to 匿名', async () => {
    const anon = { ...mockPost, nickname: null }
    queryOne.mockResolvedValueOnce(anon)
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('get', '/posts', { id: 1 })
    expect(json.post.user.name).toBe('匿名')
  })
})

// ── POST /posts ──────────────────────────────────────────────────

describe('POST /posts — create', () => {
  beforeEach(() => vi.clearAllMocks())

  const user = { id: 1, role: 'user' }

  it('returns error when title is empty', async () => {
    const { json } = await callRoute('post', '/posts', { title: '  ' }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('标题不能为空')
  })

  it('returns error when title is missing', async () => {
    const { json } = await callRoute('post', '/posts', {}, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('标题不能为空')
  })

  it('creates post with all fields', async () => {
    queryRun.mockResolvedValueOnce({ insertId: 10 })

    const { json } = await callRoute('post', '/posts', {
      title: 'New Post',
      contentHtml: '<p>Content</p>',
      contentText: 'Plain',
      board: 'trading',
      category: 'tech',
      images: ['/uploads/1.jpg'],
      tags: 'alpha,beta',
      assetIds: ['asset-1'],
    }, user)

    expect(json.ok).toBe(true)
    expect(json.success).toBe(true)
    expect(json.postId).toBe(10)
  })

  it('sanitizes contentHtml before saving', async () => {
    queryRun.mockResolvedValueOnce({ insertId: 11 })

    await callRoute('post', '/posts', {
      title: 'XSS Test',
      contentHtml: '<p>Safe</p><script>alert(1)</script>',
    }, user)

    const sql = queryRun.mock.calls[0][0]
    expect(sql).toContain('INSERT INTO posts')
    const args = queryRun.mock.calls[0][1]
    expect(args[3]).not.toContain('script')
    expect(args[3]).toContain('<p>Safe</p>')
  })

  it('updates tag counts in post_tags table', async () => {
    queryRun.mockResolvedValueOnce({ insertId: 12 })
    queryRun.mockResolvedValue({})

    await callRoute('post', '/posts', {
      title: 'Tagged',
      tags: 'def,ghi',
    }, user)

    const tagCalls = queryRun.mock.calls.slice(1)
    const tagSqls = tagCalls.map(c => c[0])
    expect(tagSqls.some(s => s.includes('post_tags'))).toBe(true)
  })

  it('handles tags as array input', async () => {
    queryRun.mockResolvedValueOnce({ insertId: 13 })
    queryRun.mockResolvedValue({})

    const { json } = await callRoute('post', '/posts', {
      title: 'Array Tags',
      tags: ['tag1', 'tag2'],
    }, user)

    expect(json.ok).toBe(true)
  })

  it('defaults board to ideas and category to general', async () => {
    queryRun.mockResolvedValueOnce({ insertId: 14 })

    await callRoute('post', '/posts', { title: 'Defaults' }, user)

    const args = queryRun.mock.calls[0][1]
    expect(args[1]).toBe('ideas')
    expect(args[6]).toBe('general')
  })

  it('trims title', async () => {
    queryRun.mockResolvedValueOnce({ insertId: 15 })

    await callRoute('post', '/posts', { title: '  Spaced  ' }, user)

    const args = queryRun.mock.calls[0][1]
    expect(args[2]).toBe('Spaced')
  })

  it('handles DB error gracefully', async () => {
    queryRun.mockRejectedValueOnce(new Error('db fail'))

    const { json } = await callRoute('post', '/posts', { title: 'X' }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('发帖失败')
  })
})

// ── PUT /posts ───────────────────────────────────────────────────

describe('PUT /posts — update', () => {
  beforeEach(() => vi.clearAllMocks())

  const user = { id: 1, role: 'user' }

  it('returns error when post not found', async () => {
    queryOne.mockResolvedValueOnce(null)
    const { json } = await callRoute('put', '/posts', { id: 999, title: 'X' }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('帖子不存在')
  })

  it('returns error when not author or admin', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 5, title: 'Old', content: 'c', category: 'g' })
    const { json } = await callRoute('put', '/posts', { id: 1, title: 'New' }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('无权编辑')
  })

  it('allows author to update', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 1, title: 'Old', content: 'c', category: 'g' })
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('put', '/posts', { id: 1, title: 'New', category: 'tech' }, user)
    expect(json.ok).toBe(true)
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE posts'),
      expect.arrayContaining(['New', 'tech', 1])
    )
  })

  it('allows admin to update any post', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 99, title: 'Old', content: 'c', category: 'g' })
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('put', '/posts', { id: 1, title: 'Admin Edit' },
      { id: 1, role: 'admin' })
    expect(json.ok).toBe(true)
  })

  it('sanitizes content on update', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 1, title: 'Old', content: 'old', category: 'g' })
    queryRun.mockResolvedValueOnce({})

    await callRoute('put', '/posts', {
      id: 1, content: '<p>Hi</p><script>x</script>',
    }, user)

    const args = queryRun.mock.calls[0][1]
    expect(args[0]).toBe('Old')
    expect(args[1]).not.toContain('script')
    expect(args[1]).toContain('<p>Hi</p>')
  })

  it('preserves original content when not provided', async () => {
    const orig = { id: 1, user_id: 1, title: 'Old', content: 'keep', category: 'g' }
    queryOne.mockResolvedValueOnce(orig)
    queryRun.mockResolvedValueOnce({})

    await callRoute('put', '/posts', { id: 1 }, user)
    const args = queryRun.mock.calls[0][1]
    expect(args[1]).toBe('keep')
  })
})

// ── DELETE /posts ────────────────────────────────────────────────

describe('DELETE /posts', () => {
  beforeEach(() => vi.clearAllMocks())

  const user = { id: 1, role: 'user' }

  it('returns error when post not found', async () => {
    queryOne.mockResolvedValueOnce(null)
    const { json } = await callRoute('delete', '/posts', { id: 999 }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('帖子不存在')
  })

  it('returns error when not authorized', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 5 })
    const { json } = await callRoute('delete', '/posts', { id: 1 }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('无权删除')
  })

  it('allows author to delete own post', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 1 })
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('delete', '/posts', { id: 1 }, user)
    expect(json.ok).toBe(true)
    expect(json.success).toBe(true)
  })

  it('allows admin to delete any post', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 99 })
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('delete', '/posts', { id: 1 },
      { id: 1, role: 'admin' })
    expect(json.ok).toBe(true)
  })

  it('deletes associated replies', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 1 })
    queryRun.mockResolvedValueOnce({})

    await callRoute('delete', '/posts', { id: 1 }, user)
    const deleteCalls = queryRun.mock.calls.map(c => c[0])
    expect(deleteCalls.some(s => s.includes('DELETE FROM post_replies'))).toBe(true)
  })

  it('handles DB error', async () => {
    queryOne.mockRejectedValueOnce(new Error('db'))
    const { json } = await callRoute('delete', '/posts', { id: 1 }, user)
    expect(json.ok).toBe(false)
  })
})

// ── PATCH /posts/pin ─────────────────────────────────────────────

describe('PATCH /posts/pin', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pins a post (admin only)', async () => {
    queryRun.mockResolvedValueOnce({})
    const { json } = await callRoute('patch', '/posts/pin', { postId: 1, sticky: true },
      { id: 1, role: 'admin' })
    expect(json.ok).toBe(true)
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('pinned'),
      [1, 1]
    )
  })

  it('unpins a post', async () => {
    queryRun.mockResolvedValueOnce({})
    const { json } = await callRoute('patch', '/posts/pin', { postId: 1, sticky: false },
      { id: 1, role: 'admin' })
    expect(json.ok).toBe(true)
    const args = queryRun.mock.calls[0][1]
    expect(args[0]).toBe(0)
  })

  it('rejects non-admin user', async () => {
    const { json } = await callRoute('patch', '/posts/pin', { postId: 1, sticky: true },
      { id: 1, role: 'user' })
    expect(json.ok).toBe(false)
    expect(json.error).toBe('需要管理员权限')
  })
})

// ── PATCH /posts/feature ─────────────────────────────────────────

describe('PATCH /posts/feature', () => {
  beforeEach(() => vi.clearAllMocks())

  it('features a post (admin only)', async () => {
    queryRun.mockResolvedValueOnce({})
    const { json } = await callRoute('patch', '/posts/feature', { postId: 2, featured: true },
      { id: 1, role: 'admin' })
    expect(json.ok).toBe(true)
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('featured'),
      [1, 2]
    )
  })

  it('rejects non-admin', async () => {
    const { json } = await callRoute('patch', '/posts/feature', { postId: 2, featured: true },
      { id: 1, role: 'user' })
    expect(json.ok).toBe(false)
  })
})

// ── PATCH /posts/lock ────────────────────────────────────────────

describe('PATCH /posts/lock', () => {
  beforeEach(() => vi.clearAllMocks())

  it('locks a post (admin only)', async () => {
    queryRun.mockResolvedValueOnce({})
    const { json } = await callRoute('patch', '/posts/lock', { postId: 3, locked: true },
      { id: 1, role: 'admin' })
    expect(json.ok).toBe(true)
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('locked'),
      [1, 3]
    )
  })

  it('rejects non-admin', async () => {
    const { json } = await callRoute('patch', '/posts/lock', { postId: 3, locked: true },
      { id: 1, role: 'pro' })
    expect(json.ok).toBe(false)
  })
})

// ── GET /post-replies ────────────────────────────────────────────

describe('GET /post-replies', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns replies for a post', async () => {
    queryAll.mockResolvedValueOnce([{
      id: 10, post_id: 1, user_id: 2, content: 'Reply 1',
      content_html: '<p>R1</p>', content_text: 'R1 text',
      floor_number: 1, images: '[]', likes: 3,
      created_at: '2026-03-02', nickname: 'Bob',
      avatar: null, email: 'b@b.com', user_role: 'user',
      quote_reply_id: null, quote_content: null,
      quote_user_id: null, quote_user_name: null,
      quote_floor_number: null,
    }])
    queryOne.mockResolvedValueOnce({ c: 1 })

    const { json } = await callRoute('get', '/post-replies', { post: 1, page: 1 })

    expect(json.ok).toBe(true)
    expect(json.replies).toHaveLength(1)
    expect(json.replies[0].content).toBe('<p>R1</p>')
    expect(json.replies[0].contentText).toBe('R1 text')
    expect(json.replies[0].floorNumber).toBe(1)
    expect(json.replies[0].likes).toBe(3)
    expect(json.replies[0].user.name).toBe('Bob')
    expect(json.replies[0].quoteReply).toBeNull()
    expect(json.total).toBe(1)
    expect(json.totalPages).toBe(1)
  })

  it('includes quoted reply data', async () => {
    queryAll.mockResolvedValueOnce([{
      id: 11, post_id: 1, user_id: 3, content: 'Reply 2',
      content_html: '', content_text: 'R2',
      floor_number: 2, images: '[]', likes: 0,
      created_at: '2026-03-03', nickname: 'Carol',
      avatar: null, email: 'c@c.com', user_role: 'user',
      quote_reply_id: 10, quote_content: 'Reply 1',
      quote_user_id: 2, quote_user_name: 'Bob',
      quote_floor_number: 1,
    }])
    queryOne.mockResolvedValueOnce({ c: 2 })

    const { json } = await callRoute('get', '/post-replies', { post: 1 })

    expect(json.replies[0].quoteReply).toEqual({
      id: 10, contentText: 'Reply 1',
      user: { name: 'Bob' }, floorNumber: 1,
    })
  })

  it('defaults contentHtml to empty string when not set', async () => {
    queryAll.mockResolvedValueOnce([{
      id: 12, post_id: 1, user_id: 1, content: 'Plain only',
      content_html: null, content_text: '',
      floor_number: 1, images: '[]', likes: 0,
      created_at: '2026-03-04', nickname: null,
      avatar: null, email: null, user_role: 'user',
      quote_reply_id: null, quote_content: null,
      quote_user_id: null, quote_user_name: null,
      quote_floor_number: null,
    }])
    queryOne.mockResolvedValueOnce({ c: 1 })

    const { json } = await callRoute('get', '/post-replies', { post: 1 })
    expect(json.replies[0].contentHtml).toBe('')
    expect(json.replies[0].user.name).toBe('匿名')
  })
})

// ── POST /post-replies ───────────────────────────────────────────

describe('POST /post-replies — add reply', () => {
  beforeEach(() => vi.clearAllMocks())

  const user = { id: 2, nickname: 'Bob', role: 'user' }

  it('returns error when postId is missing', async () => {
    const { json } = await callRoute('post', '/post-replies', {}, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('缺少帖子ID')
  })

  it('returns error when content is empty', async () => {
    const { json } = await callRoute('post', '/post-replies', { postId: 1 }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('回复内容不能为空')
  })

  it('returns error when post is locked', async () => {
    queryOne.mockResolvedValueOnce({ locked: 1 })
    const { json } = await callRoute('post', '/post-replies',
      { postId: 1, content: 'Hi' }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('帖子已锁定')
  })

  it('creates reply on unlocked post', async () => {
    queryOne
      .mockResolvedValueOnce({ locked: 0 })
      .mockResolvedValueOnce({ m: 3 })
      .mockResolvedValueOnce({ user_id: 10 })
    queryRun.mockResolvedValueOnce({ insertId: 50 })

    const { json } = await callRoute('post', '/post-replies',
      { postId: 1, content: 'Nice!' }, user)

    expect(json.ok).toBe(true)
    expect(json.success).toBe(true)
    expect(json.replyId).toBe(50)
  })

  it('assigns correct floor number', async () => {
    queryOne
      .mockResolvedValueOnce({ locked: 0 })
      .mockResolvedValueOnce({ m: 5 })
      .mockResolvedValueOnce({ user_id: 10 })
    queryRun.mockResolvedValueOnce({ insertId: 51 })

    await callRoute('post', '/post-replies',
      { postId: 1, content: 'Floor 6' }, user)

    const args = queryRun.mock.calls[0][1]
    expect(args[7]).toBe(6)
  })

  it('sanitizes contentHtml in reply', async () => {
    queryOne
      .mockResolvedValueOnce({ locked: 0 })
      .mockResolvedValueOnce({ m: 0 })
      .mockResolvedValueOnce({ user_id: 10 })
    queryRun.mockResolvedValueOnce({ insertId: 52 })

    await callRoute('post', '/post-replies',
      { postId: 1, contentHtml: '<p>OK</p><script>bad</script>' }, user)

    const args = queryRun.mock.calls[0][1]
    expect(args[2]).not.toContain('script')
    expect(args[2]).toContain('<p>OK</p>')
  })

  it('creates notification for post author', async () => {
    queryOne
      .mockResolvedValueOnce({ locked: 0 })
      .mockResolvedValueOnce({ m: 0 })
      .mockResolvedValueOnce({ user_id: 10 })
    queryRun
      .mockResolvedValueOnce({ insertId: 53 })
      .mockResolvedValueOnce({})

    await callRoute('post', '/post-replies',
      { postId: 1, content: 'Reply' }, user)

    const notifCalls = queryRun.mock.calls.filter(c =>
      c[0].includes('INSERT INTO notifications')
    )
    expect(notifCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('does not notify self-reply', async () => {
    queryOne
      .mockResolvedValueOnce({ locked: 0 })
      .mockResolvedValueOnce({ m: 0 })
      .mockResolvedValueOnce({ user_id: 2 })
    queryRun
      .mockResolvedValueOnce({ insertId: 54 })

    await callRoute('post', '/post-replies',
      { postId: 1, content: 'Self' }, user)

    const notifCalls = queryRun.mock.calls.filter(c =>
      c[0].includes('INSERT INTO notifications')
    )
    expect(notifCalls.length).toBe(0)
  })

  it('accepts contentHtml even when content is empty', async () => {
    queryOne
      .mockResolvedValueOnce({ locked: 0 })
      .mockResolvedValueOnce({ m: 0 })
      .mockResolvedValueOnce({ user_id: 10 })
    queryRun.mockResolvedValueOnce({ insertId: 55 })

    const { json } = await callRoute('post', '/post-replies',
      { postId: 1, contentHtml: '<p>Rich only</p>' }, user)
    expect(json.ok).toBe(true)
  })

  it('handles DB error gracefully', async () => {
    queryOne.mockRejectedValueOnce(new Error('db'))
    const { json } = await callRoute('post', '/post-replies',
      { postId: 1, content: 'X' }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('回复失败')
  })
})

// ── DELETE /post-replies ─────────────────────────────────────────

describe('DELETE /post-replies', () => {
  beforeEach(() => vi.clearAllMocks())

  const user = { id: 1, role: 'user' }

  it('returns error when reply not found', async () => {
    queryOne.mockResolvedValueOnce(null)
    const { json } = await callRoute('delete', '/post-replies', { id: 999 }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('回复不存在')
  })

  it('returns error when not authorized', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 5, post_id: 1 })
    const { json } = await callRoute('delete', '/post-replies', { id: 1 }, user)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('无权删除')
  })

  it('allows author to delete own reply', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 1, post_id: 10 })
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('delete', '/post-replies', { id: 1 }, user)
    expect(json.ok).toBe(true)
    expect(json.success).toBe(true)
  })

  it('allows admin to delete any reply', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 99, post_id: 10 })
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('delete', '/post-replies', { id: 1 },
      { id: 1, role: 'admin' })
    expect(json.ok).toBe(true)
  })

  it('decrements reply_count on post', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, user_id: 1, post_id: 10 })
    queryRun.mockResolvedValueOnce({})

    await callRoute('delete', '/post-replies', { id: 1 }, user)
    const updateCalls = queryRun.mock.calls.map(c => c[0])
    expect(updateCalls.some(s => s.includes('reply_count'))).toBe(true)
  })
})

// ── POST /post-reports ───────────────────────────────────────────

describe('POST /post-reports', () => {
  beforeEach(() => vi.clearAllMocks())

  const user = { id: 1, role: 'user' }

  it('submits a report', async () => {
    queryRun.mockResolvedValueOnce({})
    const { json } = await callRoute('post', '/post-reports',
      { postId: 1, reason: 'spam', detail: 'Details here' }, user)

    expect(json.ok).toBe(true)
    expect(json.message).toBe('举报已提交')
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('post_reports'),
      [1, null, 1, 'spam', 'Details here']
    )
  })

  it('submits a reply report', async () => {
    queryRun.mockResolvedValueOnce({})
    const { json } = await callRoute('post', '/post-reports',
      { replyId: 5, reason: 'abuse' }, user)

    expect(json.ok).toBe(true)
    const args = queryRun.mock.calls[0][1]
    expect(args[0]).toBeNull()
    expect(args[1]).toBe(5)
  })
})

// ── GET /post-reports ────────────────────────────────────────────

describe('GET /post-reports', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns reports for admin', async () => {
    queryAll.mockResolvedValueOnce([{
      id: 1, post_id: 1, user_id: 1, reason: 'spam',
      reporter_name: 'Bob',
    }])

    const { json } = await callRoute('get', '/post-reports', {},
      { id: 1, role: 'admin' })

    expect(json.ok).toBe(true)
    expect(json.reports).toHaveLength(1)
  })

  it('rejects non-admin', async () => {
    const { json } = await callRoute('get', '/post-reports', {},
      { id: 1, role: 'user' })
    expect(json.ok).toBe(false)
    expect(json.error).toBe('需要管理员权限')
  })
})

// ── POST /post-images (upload) ───────────────────────────────────

// NOTE: POST /post-images uses multer middleware (postImageUpload.single('file'))
// which cannot be easily mocked via callRoute. The multer middleware intercepts
// the request before the handler runs. Tested via DELETE /post-images instead.

// ── DELETE /post-images ──────────────────────────────────────────

describe('DELETE /post-images', () => {
  beforeEach(() => vi.clearAllMocks())

  const user = { id: 1, role: 'user' }

  it('deletes asset when found', async () => {
    queryOne.mockResolvedValueOnce({
      asset_id: 'img-abc', user_id: 1,
      url: '/uploads/img-abc.jpg',
    })
    queryRun.mockResolvedValueOnce({})

    const { json } = await callRoute('delete', '/post-images', { id: 'img-abc' }, user)
    expect(json.ok).toBe(true)
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM post_assets'),
      ['img-abc', 1]
    )
  })

  it('returns ok even when asset not found', async () => {
    queryOne.mockResolvedValueOnce(null)
    const { json } = await callRoute('delete', '/post-images', { id: 'missing' }, user)
    expect(json.ok).toBe(true)
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('returns ok even when user does not match', async () => {
    queryOne.mockResolvedValueOnce(null)
    const { json } = await callRoute('delete', '/post-images', { id: 'img-x' },
      { id: 99, role: 'user' })
    expect(json.ok).toBe(true)
  })

  it('handles DB error gracefully', async () => {
    queryOne.mockRejectedValueOnce(new Error('db'))
    const { json } = await callRoute('delete', '/post-images', { id: 'x' }, user)
    expect(json.ok).toBe(false)
  })
})
