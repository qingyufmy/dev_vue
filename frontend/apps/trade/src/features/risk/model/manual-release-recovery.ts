import { createRiskWriteRecovery } from './risk-write-recovery'
export interface PendingManualRelease {
  version: 1
  userId: string
  accountId: string
  key: string
  revision: number
  body: { acknowledge_risk: true; reason: string }
}
function parsePending(value: unknown): PendingManualRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('release_storage_invalid')
  const row = value as Record<string, unknown>, body = row.body as Record<string, unknown> | null
  if (Object.keys(row).sort().join(',') !== 'accountId,body,key,revision,userId,version' || row.version !== 1
    || typeof row.userId !== 'string' || !row.userId || typeof row.accountId !== 'string' || !row.accountId
    || typeof row.key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(row.key)
    || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'acknowledge_risk,reason'
    || body.acknowledge_risk !== true || typeof body.reason !== 'string' || body.reason.length < 3 || body.reason.length > 500) throw Error('release_storage_invalid')
  return { version: 1, userId: row.userId, accountId: row.accountId, key: row.key, revision: row.revision,
    body: { acknowledge_risk: true, reason: body.reason } }
}
export type ReleaseScope = { userId: string; accountId: string }
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (scope: ReleaseScope) => `aurum:risk-release:v1:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.accountId)}`

export function readPendingRelease(storage: StoragePort, scope: ReleaseScope): PendingManualRelease | null {
  const raw = storage.getItem(storageKey(scope))
  if (raw === null) return null
  const value = parsePending(JSON.parse(raw))
  if (value.userId !== scope.userId || value.accountId !== scope.accountId) throw Error('release_scope_invalid')
  return value
}

export function createManualReleaseRecovery(deps: {
  storage: StoragePort
  key: () => string
  lock: <T>(name: string, work: () => Promise<T>) => Promise<T>
  current: (scope: ReleaseScope) => boolean
  query: (request: PendingManualRelease) => Promise<'confirmed' | 'unconfirmed'>
  send: (request: PendingManualRelease) => Promise<void>
  knownPreWriteRejection?: (error: unknown) => boolean
}) {
  return createRiskWriteRecovery<PendingManualRelease, { reason: string; revision: number }>({
    ...deps, storageKey, read: scope => readPendingRelease(deps.storage, scope), parse: parsePending,
    create: (scope, input, key) => ({ version: 1, ...scope, key, revision: input.revision,
      body: { acknowledge_risk: true, reason: input.reason.trim() } }),
    scopeError: 'release_scope_changed', storageError: 'release_storage_unavailable',
  })
}
