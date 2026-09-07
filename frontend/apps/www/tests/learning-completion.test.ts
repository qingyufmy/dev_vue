import { effectScope, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useLearningCompletion } from '../app/composables/use-learning-completion'
import type { LearningDetail } from '@aurum/contracts'

const lesson: LearningDetail['lessons'][number] = { id: '99', title: 'lesson', duration_ms: null, resources: [],
  progress: { completed: false, revision: '5', watched_ms: '10000', reported_duration_ms: null, updated_at: null } }
const session = { data: { user: { id: '7', display_name: '用户', avatar_url: null }, app: 'www', permissions: [],
  authenticated_at: '2026-09-07T00:00:00Z', mfa_level: 'none', csrf_token: 'csrf' }, meta: { request_id: 'r', generated_at: '2026-09-07T00:00:00Z' } }
const response = { data: { lesson_id: '99', completed: true, revision: '6', updated_at: '2026-09-07T01:00:00Z', replayed: false } }
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function fixture() {
  const context = ref({ courseId: '12', viewerUserId: '7' as string | null })
  const refresh = vi.fn(async () => {})
  const fetcher = vi.fn(async (path: string, _options?: unknown): Promise<unknown> => path === '/api/v4/session' ? structuredClone(session) : structuredClone(response))
  const scope = effectScope(); scopes.push(scope)
  const controller = scope.run(() => useLearningCompletion(() => context.value, refresh, fetcher))!
  return { context, refresh, fetcher, controller, scope }
}
it('saves against the displayed viewer and exact revision, then refreshes authoritative progress', async () => {
  const f = fixture(); await f.controller.save(lesson)
  expect(f.fetcher.mock.calls[1]).toEqual(['/api/v4/learning/courses/12/lessons/99/completion', {
    method: 'PUT', retry: 0, headers: { 'X-CSRF-Token': 'csrf', 'Idempotency-Key': expect.any(String) },
    body: { completed: true, expected_revision: '5' },
  }])
  expect(f.refresh).toHaveBeenCalledOnce(); expect(f.controller.stateFor('99').phase).toBe('saved')
})
it('keeps the original request key and body for an uncertain result, even if the displayed lesson changes', async () => {
  const f = fixture()
  f.fetcher.mockImplementationOnce(async () => session).mockRejectedValueOnce({ statusCode: 503 })
  await f.controller.save(lesson)
  expect(f.controller.stateFor('99').phase).toBe('uncertain')
  await f.controller.save({ ...lesson, progress: { ...lesson.progress!, completed: true, revision: '8' } })
  expect(f.fetcher.mock.calls[3]?.[1]).toEqual(f.fetcher.mock.calls[1]?.[1])
  expect(f.controller.stateFor('99').phase).toBe('saved')
})
it('requires a refresh after a revision conflict instead of automatically overwriting', async () => {
  const f = fixture()
  f.fetcher.mockImplementationOnce(async () => session).mockRejectedValueOnce({ statusCode: 409 })
  await f.controller.save(lesson)
  expect(f.controller.stateFor('99').phase).toBe('reload')
  await f.controller.save(lesson)
  expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.refresh).toHaveBeenCalledOnce()
  expect(f.controller.stateFor('99').phase).toBe('idle')
})
it('does not write through an old user snapshot after the login account changes', async () => {
  const f = fixture()
  f.fetcher.mockResolvedValueOnce({ ...session, data: { ...session.data, user: { ...session.data.user, id: '8' } } })
  await f.controller.save(lesson)
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.refresh).toHaveBeenCalledOnce()
  expect(f.refresh).toHaveBeenCalledWith(true)
  expect(f.controller.stateFor('99').phase).toBe('reload')
})
it('ignores a late completion when the course changes', async () => {
  const f = fixture()
  let finish!: (value: unknown) => void
  f.fetcher.mockImplementationOnce(async () => session).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const saving = f.controller.save(lesson)
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2))
  f.context.value = { courseId: '13', viewerUserId: '7' }
  finish(response); await saving
  expect(f.refresh).not.toHaveBeenCalled(); expect(f.controller.stateFor('99').phase).toBe('idle')
})
it('does not submit after the component is disposed while its session check is pending', async () => {
  const f = fixture()
  let finish!: (value: unknown) => void
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const saving = f.controller.save(lesson)
  f.scope.stop(); finish(session); await saving
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.refresh).not.toHaveBeenCalled()
})
it('ignores repeated activation while a save is pending without requiring native disabled focus loss', async () => {
  const f = fixture()
  let finish!: (value: unknown) => void
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const saving = f.controller.save(lesson)
  await f.controller.save(lesson)
  expect(f.fetcher).toHaveBeenCalledOnce()
  finish(session); await saving
  expect(f.fetcher).toHaveBeenCalledTimes(2)
  expect(f.controller.stateFor('99').phase).toBe('saved')
})
