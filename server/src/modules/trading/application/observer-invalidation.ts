/** Internal control message, never a browser publication DTO. */
export interface ObserverInvalidation {
  source_id: string | null
  channel_id: string | null
  user_id: number | null
  registry_revision: number
}

export const OBSERVER_CONTROL_CHANNEL = 'aurum:v4:observer-authorization'

export function observerInvalidation(value: unknown): ObserverInvalidation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const keys = Object.keys(data).sort().join(',')
  if (keys !== 'channel_id,registry_revision,source_id,user_id') return null
  const id = (input: unknown) => input === null || typeof input === 'string' && /^[1-9][0-9]{0,19}$/.test(input)
  if (!id(data.source_id) || !id(data.channel_id)
    || data.user_id !== null && (!Number.isSafeInteger(data.user_id) || Number(data.user_id) < 1 || Number(data.user_id) > 2_147_483_647)
    || !Number.isSafeInteger(data.registry_revision) || Number(data.registry_revision) < 1) return null
  return {
    source_id: data.source_id as string | null, channel_id: data.channel_id as string | null,
    user_id: data.user_id as number | null, registry_revision: Number(data.registry_revision),
  }
}
