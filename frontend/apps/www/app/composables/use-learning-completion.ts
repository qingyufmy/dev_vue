import { onScopeDispose, ref, watch } from 'vue'
import { learningCompletionSchema, sessionResponseSchema, type LearningDetail } from '@aurum/contracts'

type Lesson = LearningDetail['lessons'][number]
type Fetcher = (path: string, options?: { method?: 'PUT'; headers?: Record<string, string>; body?: { completed: boolean; expected_revision: string }; retry?: number }) => Promise<unknown>
type Phase = 'idle' | 'saving' | 'uncertain' | 'reload' | 'error' | 'saved'
interface State { phase: Phase; message: string }
interface Pending { requestId: string; body: { completed: boolean; expected_revision: string } }

export function useLearningCompletion(context: () => { courseId: string; viewerUserId: string | null }, refresh: (invalidate?: boolean) => Promise<unknown>, fetcher: Fetcher = (path, options) => $fetch<unknown>(path, options)) {
  const states = ref<Record<string, State>>({}), pending = new Map<string, Pending>()
  let generation = 0
  const reset = () => { generation++; states.value = {}; pending.clear() }
  watch(() => `${context().courseId}/${context().viewerUserId ?? 'guest'}`, reset, { flush: 'sync' })
  onScopeDispose(reset)
  const stateFor = (id: string): State => states.value[id] ?? { phase: 'idle', message: '' }
  const setState = (id: string, phase: Phase, message: string) => { states.value[id] = { phase, message } }
  async function reload(id: string) {
    const current = generation
    setState(id, 'saving', '正在更新学习记录…')
    try { await refresh(); if (current === generation) setState(id, 'idle', '') }
    catch { if (current === generation) setState(id, 'reload', '记录暂时无法更新，请重试刷新。') }
  }
  async function save(lesson: Lesson) {
    const scope = context(), current = generation
    if (!scope.viewerUserId || stateFor(lesson.id).phase === 'saving') return
    if (stateFor(lesson.id).phase === 'reload') return reload(lesson.id)
    const operation = pending.get(lesson.id) ?? { requestId: crypto.randomUUID(),
      body: { completed: !lesson.progress?.completed, expected_revision: lesson.progress?.revision ?? '0' } }
    pending.set(lesson.id, operation)
    setState(lesson.id, 'saving', '正在保存…')
    try {
      const session = sessionResponseSchema.parse(await fetcher('/api/v4/session', { retry: 0 }))
      if (current !== generation) return
      if (session.data.app !== 'www' || session.data.user.id !== scope.viewerUserId) {
        pending.delete(lesson.id)
        setState(lesson.id, 'reload', '登录账号已变化，请刷新课程后再操作。')
        try { await refresh(true) } catch { /* Keep the refresh-only action; no write was attempted. */ }
        return
      }
      const response = await fetcher(`/api/v4/learning/courses/${scope.courseId}/lessons/${lesson.id}/completion`, {
        method: 'PUT', retry: 0, headers: { 'X-CSRF-Token': session.data.csrf_token, 'Idempotency-Key': operation.requestId }, body: operation.body,
      }) as { data: unknown }
      const result = learningCompletionSchema.parse(response.data)
      if (result.lesson_id !== lesson.id || result.completed !== operation.body.completed
        || result.revision !== (BigInt(operation.body.expected_revision) + 1n).toString()) throw Error('learning_response_mismatch')
      if (current !== generation) return
      pending.delete(lesson.id)
      try {
        await refresh()
        if (current === generation) setState(lesson.id, 'saved', result.completed ? '已标记为学完。' : '已取消完成标记。')
      } catch { if (current === generation) setState(lesson.id, 'reload', '已保存，请刷新课程查看最新记录。') }
    } catch (error) {
      if (current !== generation) return
      const status = (error as { statusCode?: number; response?: { status?: number } })?.statusCode
        ?? (error as { response?: { status?: number } })?.response?.status
      if (status && status >= 400 && status < 500) {
        pending.delete(lesson.id)
        setState(lesson.id, 'reload', status === 409 ? '记录已发生变化，请刷新后确认，再决定是否修改。'
          : status === 401 || status === 403 ? '登录或课程权限已变化，请刷新课程。' : '暂时无法保存，请刷新课程后重试。')
        if (status === 401 || status === 403) { try { await refresh(true) } catch { /* The page shows its read error. */ } }
      } else setState(lesson.id, 'uncertain', '暂时无法确认保存结果，请点击“确认保存结果”重试。')
    }
  }
  return { stateFor, save, reload }
}
