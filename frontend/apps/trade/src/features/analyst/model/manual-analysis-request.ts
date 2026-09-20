import { analysisJobCreateSchema, type AnalysisJobCreate } from '@aurum/contracts'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const keyFor = (user: string) => `aurum:manual-analysis:v1:${encodeURIComponent(user)}`
export function prepareManualAnalysis(storage: Storage, user: string, body: AnalysisJobCreate) {
  const parsed = analysisJobCreateSchema.parse(body)
  const raw = storage.getItem(keyFor(user))
  if (raw) {
    const saved = JSON.parse(raw) as { body: AnalysisJobCreate; idempotencyKey: string }
    if (typeof saved.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(saved.idempotencyKey)) throw new Error('上次分析请求记录无效，请联系管理员核对')
    if (JSON.stringify(analysisJobCreateSchema.parse(saved.body)) !== JSON.stringify(parsed)) throw new Error('上次提交尚未确认，请按原策略和品种重试')
    return saved
  }
  const request = { body: parsed, idempotencyKey: crypto.randomUUID() }
  storage.setItem(keyFor(user), JSON.stringify(request))
  return request
}
export function clearManualAnalysis(storage: Storage, user: string) { storage.removeItem(keyFor(user)) }
