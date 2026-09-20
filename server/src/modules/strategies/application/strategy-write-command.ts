import { createHash } from 'node:crypto'
import { StrategyAccessError } from '../domain/strategy.js'

export const strategyWriteActions = ['create_strategy', 'update_metadata', 'create_version', 'publish_version',
  'retire_strategy', 'create_subscription', 'update_subscription', 'set_account_trader',
  'create_strategy_combination', 'create_strategy_combination_version'] as const
export type StrategyWriteAction = typeof strategyWriteActions[number]
export interface StrategyWriteCommand {
  actorUserId: number
  idempotencyKey: string
  action: StrategyWriteAction
  targetId: string | null
  expectedRevision: number | null
  payload: Record<string, unknown>
}

// Canonical JSON only: reject silent JSON.stringify conversions and excessive nesting.
export function strategyWriteJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new StrategyAccessError('strategy_write_invalid', 400)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new StrategyAccessError('strategy_write_invalid', 400)
    return `[${Array.from(value, item => strategyWriteJson(item, depth + 1)).join(',')}]`
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === Object.keys(value).length) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${strategyWriteJson((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
  }
  throw new StrategyAccessError('strategy_write_invalid', 400)
}

export function strategyWriteHash(value: string): string { return createHash('sha256').update(value).digest('hex') }

export function strategyCommandHash(command: StrategyWriteCommand): string {
  if (!Number.isSafeInteger(command.actorUserId) || command.actorUserId < 1 || command.actorUserId > 2147483647
    || typeof command.idempotencyKey !== 'string' || !/^[\x21-\x7e]{16,128}$/.test(command.idempotencyKey) || /[^\x21-\x7e]/.test(command.idempotencyKey)
    || !strategyWriteActions.includes(command.action)
    || (command.targetId !== null && !validStrategyResourceId(command.targetId))
    || (command.expectedRevision !== null && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1))
    || !command.payload || Array.isArray(command.payload) || typeof command.payload !== 'object') {
    throw new StrategyAccessError('strategy_write_invalid', 400)
  }
  return strategyWriteHash(strategyWriteJson(['strategy-write/v1', command.actorUserId, command.action,
    command.targetId, command.expectedRevision, command.payload]))
}

export function validStrategyResourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(value) && !/[^A-Za-z0-9._:-]/.test(value)
}
