const ATTEMPT_KEY = 'aurum.www.login-attempt'
const ATTEMPT_WINDOW_MS = 60_000

export function safeLoginNext(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || /[\\\u0000-\u0020\u007f]/.test(value)) return '/'
  try {
    const url = new URL(value, 'https://application.invalid')
    if (url.origin !== 'https://application.invalid' || /^\/(?:auth|login|api)(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return '/'
    return url.pathname + url.search + url.hash
  } catch { return '/' }
}

export function clearLoginAttempt() {
  try { sessionStorage.removeItem(ATTEMPT_KEY) } catch { /* Login remains available without browser storage. */ }
}

export function beginAutomaticLogin(now = Date.now()) {
  try {
    const previous = Number(sessionStorage.getItem(ATTEMPT_KEY))
    if (previous > 0 && now - previous < ATTEMPT_WINDOW_MS) return false
    sessionStorage.setItem(ATTEMPT_KEY, String(now))
    return true
  } catch { return false }
}
