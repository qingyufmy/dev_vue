import { describe, expect, it } from 'vitest'

import { router } from '../src/router'

describe('admin route inventory', () => {
  it('keeps platform operations and site configuration addressable', () => {
    const paths = router.getRoutes().map((route) => route.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/', '/users', '/content', '/strategies', '/models', '/risk', '/bridge', '/commercial',
      '/notifications', '/site-settings', '/audit', '/system',
    ]))
  })

  it('keeps an independent administrator login landing', () => {
    expect(router.getRoutes().find((route) => route.path === '/login')?.meta.public).toBe(true)
  })
})
