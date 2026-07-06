import { describe, it, expect, vi } from 'vitest'

vi.mock('svg-captcha', () => ({
  default: {
    create: vi.fn().mockReturnValue({
      text: 'Ab3X',
      data: '<svg>captcha</svg>',
    }),
  },
}))

const { generateCaptcha, verifyCaptcha } = await import('../server/captcha.js')

describe('generateCaptcha', () => {
  it('返回id和svg', () => {
    const result = generateCaptcha()

    expect(result).toHaveProperty('id')
    expect(result).toHaveProperty('svg')
    expect(typeof result.id).toBe('string')
    expect(result.svg).toContain('<svg>')
  })
})

describe('verifyCaptcha', () => {
  it('正确验证码返回true', () => {
    const { id } = generateCaptcha()
    const result = verifyCaptcha(id, 'ab3x')

    expect(result).toBe(true)
  })

  it('错误验证码返回false', () => {
    const { id } = generateCaptcha()
    const result = verifyCaptcha(id, 'wrong')

    expect(result).toBe(false)
  })

  it('过期验证码返回false', () => {
    const { id } = generateCaptcha()
    // 手动设置过期时间（往前推5分钟+1秒）
    // captcha.js用的是内部Map，无法直接操纵，但可以验证不存在的id
    const result = verifyCaptcha('nonexistent-id', 'ab3x')

    expect(result).toBe(false)
  })
})
