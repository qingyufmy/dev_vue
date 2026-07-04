import svgCaptcha from 'svg-captcha'

const captchaStore = new Map()
const CAPTCHA_TTL = 5 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of captchaStore) {
    if (now - entry.createdAt > CAPTCHA_TTL) captchaStore.delete(id)
  }
}, 60_000)

export function generateCaptcha() {
  const captcha = svgCaptcha.create({
    size: 4,
    ignoreChars: '0o1lI',
    noise: 3,
    color: true,
    background: '#f0f0f0',
    width: 120,
    height: 40,
  })
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  captchaStore.set(id, { code: captcha.text.toLowerCase(), createdAt: Date.now(), used: false })
  return { id, svg: captcha.data }
}

export function verifyCaptcha(id, code) {
  if (!id || !code) return false
  const entry = captchaStore.get(id)
  if (!entry || entry.used) return false
  if (Date.now() - entry.createdAt > CAPTCHA_TTL) {
    captchaStore.delete(id)
    return false
  }
  entry.used = true
  return entry.code === code.toLowerCase()
}
