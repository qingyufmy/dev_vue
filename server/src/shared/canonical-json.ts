import { createHash } from 'node:crypto'

export class CanonicalJsonError extends Error {
  constructor() { super('canonical_json_invalid') }
}

/** Existing V4 encoding, not RFC 8785. Changing it requires stored-hash compatibility review. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError()
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new CanonicalJsonError()
}

export function sha256Canonical(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
