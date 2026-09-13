import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import nodeFetch from 'node-fetch-native/node'
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
    fetch: nodeFetch,
    headers: { host: 'localhost:3100' }, fetchOptions: { redirect: 'manual' },
  })
})

it('sends the public host over HTTP and leaves callback redirects and cookies intact', async () => {
  const upstream = createServer((request, response) => {
    expect(request.headers.host).toBe('localhost:3100')
    response.writeHead(302, {
      Location: '/courses',
      'Set-Cookie': 'www_session=test; Path=/; HttpOnly; SameSite=Lax',
    })
    response.end()
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  try {
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')
    vi.stubGlobal('useRuntimeConfig', () => ({ learningApiBase: `http://127.0.0.1:${address.port}`, learningWwwOrigin: 'http://localhost:3100' }))
    vi.stubGlobal('setResponseHeader', vi.fn())
    vi.stubGlobal('proxyRequest', async (_event: unknown, target: string, options: { fetch: typeof fetch; headers: Record<string, string>; fetchOptions: RequestInit }) => {
      const response = await options.fetch(target, { ...options.fetchOptions, headers: options.headers })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/courses')
      expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    })
    await proxyWwwRequest({} as Parameters<typeof proxyWwwRequest>[0], '/auth/callback')
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})
