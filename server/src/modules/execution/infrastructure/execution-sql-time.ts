import { ExecutionError } from '../domain/execution.js'
export function executionSqlTime(value: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new ExecutionError('execution_time_invalid', 422)
  return value.slice(0, 23).replace('T', ' ')
}
export const executionNullableSqlTime = (value: string | null) => value === null ? null : executionSqlTime(value)
export function executionIsoTime(value: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(value)
  const iso = match ? match[1]!.replace(' ', 'T') + '.' + (match[2] ?? '').padEnd(3, '0') + 'Z' : value
  executionSqlTime(iso)
  return iso
}
