// @vitest-environment node
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'vite'
import { expect, it, vi } from 'vitest'
import configure from '../vite.config'

it('proxies auth redirects and cookies without changing browser Origin or Host', async () => {
  const requests: Array<{ path: string; host?: string; origin?: string; cookie?: string }> = []
  const upstream = createHttpServer((request, response) => {
    requests.push({ path: request.url!, host: request.headers.host, origin: request.headers.origin, cookie: request.headers.cookie })
    response.writeHead(302, { Location: '/login?state=frozen', 'Set-Cookie': 'fixture_session=value; Path=/; HttpOnly; SameSite=Strict' })
    response.end()
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  vi.stubEnv('AURUM_AUTH_API_BASE', `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`)
  let proxy: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    if (typeof configure !== 'function') throw new Error('expected config factory')
    const config = await configure({ mode: 'test', command: 'serve' })
    proxy = await createServer({ configFile: false, logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, hmr: false, proxy: config.server?.proxy },
    })
    await proxy.listen()
    const base = `http://127.0.0.1:${(proxy.httpServer!.address() as AddressInfo).port}`
    const response = await fetch(`${base}/oauth/authorize?state=frozen`, { redirect: 'manual', headers: {
      Origin: 'https://untrusted.example.test', Cookie: 'fixture_session=existing',
    } })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?state=frozen')
    expect(response.headers.get('set-cookie')).toContain('fixture_session=value;')
    expect(requests).toEqual([{ path: '/oauth/authorize?state=frozen', host: new URL(base).host,
      origin: 'https://untrusted.example.test', cookie: 'fixture_session=existing' }])
    await fetch(`${base}/api/v4/auth/login-extra`, { redirect: 'manual' })
    expect(requests).toHaveLength(1)
  } finally {
    await proxy?.close()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    vi.unstubAllEnvs()
  }
})
