import { afterEach, expect, it, vi } from 'vitest'
import { proxyWwwRequest } from '../server/utils/www-proxy'

afterEach(() => vi.unstubAllGlobals())

it('preserves browser callback redirects through the fixed www upstream', async () => {
  vi.stubGlobal('useRuntimeConfig', () => ({ learningApiBase: 'http://127.0.0.1:3010', learningWwwOrigin: 'http://localhost:3100' }))
  const setHeader = vi.fn(), proxy = vi.fn(async () => 'proxied')
  vi.stubGlobal('setResponseHeader', setHeader)
  vi.stubGlobal('proxyRequest', proxy)
  const event = {} as Parameters<typeof proxyWwwRequest>[0]
  expect(await proxyWwwRequest(event, '/auth/callback', { code: 'one-use', state: 'frozen' })).toBe('proxied')
  expect(setHeader).toHaveBeenCalledWith(event, 'Cache-Control', 'private, no-store')
  expect(proxy).toHaveBeenCalledWith(event, 'http://127.0.0.1:3010/auth/callback?code=one-use&state=frozen', {
    headers: { host: 'localhost:3100' }, fetchOptions: { redirect: 'manual' },
  })
})
