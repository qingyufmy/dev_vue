import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthService } from '../src/modules/auth/index.js'
import { LearningService } from '../src/modules/learning/application/learning-service.js'
import { learningRoutes } from '../src/modules/learning/transport/http/learning-routes.js'
import { learningResourceUrl, MysqlLearningReader } from '../src/modules/learning/infrastructure/mysql-learning-reader.js'
import { MysqlLearningMembershipReader } from '../src/modules/commerce/infrastructure/mysql-learning-membership-reader.js'
import type { LearningReader, CourseSummary } from '../src/modules/learning/domain/learning.js'
import type { Pool } from 'mysql2/promise'
const course: CourseSummary = { id: '12', title: '课程', description: null, category: null, access_level: 'logged_in', updated_at: '2026-09-07T00:00:00.123Z', sort_order: 0 }
function fixture() {
  const reader: LearningReader = { list: vi.fn(async () => [course]), course: vi.fn(async () => course), lessons: vi.fn(async () => []) }
  const memberships = { activePlan: vi.fn(async (): Promise<'free' | 'plus' | 'pro'> => 'free') }
  return { reader, memberships, service: new LearningService(reader, memberships) }
}
const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => { for (const app of apps.splice(0)) await app.close() })
describe('learning read authorization', () => {
  it('returns no protected lessons for guests or insufficient plans', async () => {
    const f = fixture()
    expect((await f.service.detail('12', null)).access).toBe('login_required')
    expect(f.reader.lessons).not.toHaveBeenCalled()
    vi.mocked(f.reader.course).mockResolvedValue({ ...course, access_level: 'pro_only' })
    expect((await f.service.detail('12', 7)).access).toBe('membership_required')
    expect(f.reader.lessons).not.toHaveBeenCalled()
    f.memberships.activePlan.mockResolvedValue('pro')
    expect((await f.service.detail('12', 7)).access).toBe('allowed')
    expect(f.reader.lessons).toHaveBeenCalledWith('12', 7)
  })
  it('allows free courses without fetching somebody else’s progress and rejects unpublished IDs', async () => {
    const f = fixture(); vi.mocked(f.reader.course).mockResolvedValue({ ...course, access_level: 'free' })
    await f.service.detail('12', null)
    expect(f.reader.lessons).toHaveBeenCalledWith('12', null)
    vi.mocked(f.reader.course).mockResolvedValue(null)
    await expect(f.service.detail('12', 7)).rejects.toThrow('learning_course_not_found')
    await expect(f.service.list('0:1 OR 1=1')).rejects.toThrow('learning_cursor_invalid')
  })
  it('paginates with a stable compound cursor and bounded lookahead', async () => {
    const f = fixture(); vi.mocked(f.reader.list).mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ ...course, id: String(i + 1) })))
    const page = await f.service.list('0:4')
    expect(page.items).toHaveLength(20); expect(page.next_cursor).toBe('0:20')
    expect(f.reader.list).toHaveBeenCalledWith({ order: 0, id: '4' }, 21)
  })
  it('accepts only www cookie identity and ignores caller-supplied user_id', async () => {
    const f = fixture(), app = Fastify(); apps.push(app)
    const resolveSession = vi.fn(async () => ({ user: { id: 7 } }))
    await app.register(learningRoutes, { prefix: '/api/v4', service: f.service, wwwOrigin: 'https://www.example.test',
      auth: { cookieName: () => 'www_session', resolveSession } as unknown as AuthService })
    const url = '/api/v4/learning/courses/12?user_id=999'
    const guest = await app.inject({ url, headers: { host: 'www.example.test', cookie: 'trade_session=secret' } })
    expect(guest.json().data.access).toBe('login_required'); expect(resolveSession).not.toHaveBeenCalled()
    const signed = await app.inject({ url, headers: { host: 'www.example.test', cookie: 'www_session=opaque' } })
    expect(signed.statusCode).toBe(200); expect(signed.headers['cache-control']).toBe('private, no-store')
    expect(resolveSession).toHaveBeenCalledWith('opaque', 'www-web'); expect(f.reader.lessons).toHaveBeenCalledWith('12', 7)
    expect((await app.inject({ url, headers: { host: 'trade.example.test' } })).statusCode).toBe(421)
  })
  it('does not leak repository exceptions', async () => {
    const f = fixture(), app = Fastify(); apps.push(app)
    vi.mocked(f.reader.list).mockRejectedValue(new Error('private database detail'))
    await app.register(learningRoutes, { service: f.service, wwwOrigin: 'https://www.example.test', auth: {} as AuthService })
    const result = await app.inject({ url: '/learning/courses', headers: { host: 'www.example.test' } })
    expect(result.statusCode).toBe(503); expect(result.body).not.toContain('private database detail')
  })
})
it('binds progress to authenticated user and does not return storage paths', async () => {
  const execute = vi.fn(async (_sql: string, _params: unknown[]) => [[{ id: '1', title: 'lesson', duration_ms: '9007199254740993', progress_id: null }]])
  const query = vi.fn(async () => [[{ lesson_id: '1', source_kind: 'local_video_path', locator: '/secret/video' }]])
  const reader = new MysqlLearningReader({ execute, query } as unknown as Pool)
  const lessons = await reader.lessons('12', 7)
  expect(execute.mock.calls[0]?.[1]).toEqual([7, '12'])
  expect(lessons[0]?.resources).toEqual([]); expect(lessons[0]?.progress).toBeNull()
  expect(lessons[0]?.duration_ms).toBe('9007199254740993')
})
it('reads active membership only and defaults missing/expired results to free', async () => {
  const execute = vi.fn(async (_sql: string, _params: unknown[]) => [[]])
  const reader = new MysqlLearningMembershipReader({ execute } as unknown as Pool)
  const now = new Date('2026-09-07T00:00:00Z')
  expect(await reader.activePlan(7, now)).toBe('free')
  expect(execute.mock.calls[0]?.[1]).toEqual([7, now])
  expect(execute.mock.calls[0]?.[0]).toContain("expires_at_utc>?")
})
it('accepts only navigable resources and never exposes internal object keys', () => {
  expect(learningResourceUrl('bilibili_id', 'BV123abc')).toBe('https://www.bilibili.com/video/BV123abc')
  expect(learningResourceUrl('article_url', 'javascript:alert(1)')).toBeNull()
  expect(learningResourceUrl('article_url', 'https://user:password@example.test')).toBeNull()
  expect(learningResourceUrl('article_object_key', 'private/key')).toBeNull()
})

it('normalizes SQL numeric text for cursor fields without coercing precise durations', async () => {
  const row = { ...course, sort_order: '7' }
  const pool = { query: vi.fn(async () => [[row]]), execute: vi.fn(async () => [[row]]) } as unknown as Pool
  const reader = new MysqlLearningReader(pool)
  expect((await reader.list(null, 21))[0]?.sort_order).toBe(7)
  expect((await reader.course('12'))?.sort_order).toBe(7)
})
