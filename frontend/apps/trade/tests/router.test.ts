import { describe, expect, it } from 'vitest'

import { router } from '../src/router'

describe('trade route inventory', () => {
  it('keeps every required trading-lab destination addressable', () => {
    const paths = router.getRoutes().map((route) => route.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/', '/market', '/analyst', '/trader', '/risk', '/strategist', '/reviewer', '/trades', '/audit',
    ]))
  })

  it('keeps the login landing outside the protected shell', () => {
    expect(router.getRoutes().find((route) => route.path === '/login')?.meta.public).toBe(true)
  })
})
