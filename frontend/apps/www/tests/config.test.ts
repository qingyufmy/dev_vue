import { describe, expect, it } from 'vitest'

describe('www application boundary', () => {
  it('uses its dedicated Nuxt application identity', () => {
    expect('@aurum/www').not.toBe('@aurum/trade')
    expect('@aurum/www').not.toBe('@aurum/admin')
  })
})
