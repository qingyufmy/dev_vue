import { describe, expect, it } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import { isCorsOriginAllowed, normalizeMysqlPoolSize, PUBLIC_UPLOAD_DIR, resolvePublicUploadDir, parseCorsOrigins } from '../server/config.js'

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

  it('supports protocol-independent domains, subdomains, IPs and explicit ports', () => {
    const rules = parseCorsOrigins('cnfxtrade.com,192.168.1.254,localhost:3000,https://exact.example.com')
    expect(isCorsOriginAllowed('https://cnfxtrade.com', rules)).toBe(true)
    expect(isCorsOriginAllowed('http://www.cnfxtrade.com', rules)).toBe(true)
    expect(isCorsOriginAllowed('https://ai.ops.cnfxtrade.com', rules)).toBe(true)
    expect(isCorsOriginAllowed('http://192.168.1.254', rules)).toBe(true)
    expect(isCorsOriginAllowed('https://localhost:3000', rules)).toBe(true)
    expect(isCorsOriginAllowed('https://exact.example.com', rules)).toBe(true)

    expect(isCorsOriginAllowed('https://evil-cnfxtrade.com', rules)).toBe(false)
    expect(isCorsOriginAllowed('https://cnfxtrade.com.evil.example', rules)).toBe(false)
    expect(isCorsOriginAllowed('https://cnfxtrade.com:8443', rules)).toBe(false)
    expect(isCorsOriginAllowed('http://192.168.1.254:3000', rules)).toBe(false)
    expect(isCorsOriginAllowed('http://192.168.1.255', rules)).toBe(false)
    expect(isCorsOriginAllowed('http://exact.example.com', rules)).toBe(false)
    expect(isCorsOriginAllowed('ftp://cnfxtrade.com', rules)).toBe(false)
    expect(isCorsOriginAllowed('https://cnfxtrade.com/path', rules)).toBe(false)
  })
})
