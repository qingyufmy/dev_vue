import { describe, expect, it } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import { normalizeMysqlPoolSize, PUBLIC_UPLOAD_DIR, resolvePublicUploadDir, parseCorsOrigins } from '../server/config.js'

describe('server configuration', () => {
  it('keeps at least two MySQL connections so the migration lock cannot exhaust the pool', () => {
    expect(normalizeMysqlPoolSize('1')).toBe(2)
    expect(normalizeMysqlPoolSize('2')).toBe(2)
    expect(normalizeMysqlPoolSize('12')).toBe(12)
    expect(normalizeMysqlPoolSize('invalid')).toBe(10)
  })

  it('resolves every public upload route from the same server directory', () => {
    expect(isAbsolute(PUBLIC_UPLOAD_DIR)).toBe(true)
    expect(PUBLIC_UPLOAD_DIR.replaceAll('\\', '/')).toMatch(/\/server\/uploads$/)
    expect(resolvePublicUploadDir('D:\\custom-uploads')).toBe(resolve('D:\\custom-uploads'))
  })

  it('normalizes and de-duplicates configured CORS origins', () => {
    expect(parseCorsOrigins(' https://example.com, http://localhost:3000,https://example.com, ')).toEqual([
      'https://example.com',
      'http://localhost:3000',
    ])
  })
})
