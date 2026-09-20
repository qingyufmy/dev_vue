import { riskPolicyPatchBodySchema, type RiskPolicyPatchBody } from '@aurum/contracts'
import { createRiskWriteRecovery } from './risk-write-recovery'

export interface PendingPolicyWrite {
  version: 1
  userId: string
  accountId: string
  key: string
  revision: number
  body: RiskPolicyPatchBody
}
type Scope = { userId: string; accountId: string }
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (scope: Scope) => `aurum:risk-policy:v1:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.accountId)}`

function parsePending(value: unknown): PendingPolicyWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('policy_storage_invalid')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'accountId,body,key,revision,userId,version' || row.version !== 1
    || typeof row.userId !== 'string' || !row.userId || typeof row.accountId !== 'string' || !row.accountId
    || typeof row.key !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(row.key)
    || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0) throw Error('policy_storage_invalid')
  const body = riskPolicyPatchBodySchema.parse(row.body)
  if (Object.keys(body).every(key => key === 'reason')) throw Error('policy_changes_required')
  return { version: 1, userId: row.userId, accountId: row.accountId, key: row.key, revision: row.revision, body }
}

export function readPendingPolicy(storage: StoragePort, scope: Scope) {
  const raw = storage.getItem(storageKey(scope))
  if (raw === null) return null
  const request = parsePending(JSON.parse(raw))
  if (request.userId !== scope.userId || request.accountId !== scope.accountId) throw Error('policy_scope_invalid')
  return request
}

export function createPolicyWriteRecovery(deps: {
  storage: StoragePort
  key: () => string
  lock: <T>(name: string, work: () => Promise<T>) => Promise<T>
  current: (scope: Scope) => boolean
  query: (request: PendingPolicyWrite) => Promise<'confirmed' | 'unconfirmed'>
  send: (request: PendingPolicyWrite) => Promise<void>
  knownPreWriteRejection?: (error: unknown) => boolean
}) {
  return createRiskWriteRecovery<PendingPolicyWrite, { body: RiskPolicyPatchBody; revision: number }>({
    ...deps, storageKey, read: scope => readPendingPolicy(deps.storage, scope), parse: parsePending,
    create: (scope, input, key) => ({ version: 1, ...scope, key, revision: input.revision, body: input.body }),
    scopeError: 'policy_scope_changed', storageError: 'policy_storage_unavailable',
  })
}
