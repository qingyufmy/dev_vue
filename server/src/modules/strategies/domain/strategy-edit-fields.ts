import { StrategyAccessError, type CreateStrategyVersionInput } from './strategy.js'

/** Optional fields are part of the same revision and receipt as the saved version. */
export function strategyEditFields(input: CreateStrategyVersionInput) {
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 191)
    || input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)
    || input.status !== undefined && input.status !== 'active' && input.status !== 'draft') {
    throw new StrategyAccessError('request_field_invalid', 422)
  }
  return { ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.status === undefined ? {} : { status: input.status }) }
}
