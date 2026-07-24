(function () {
  const COOKIE_NAME = 'ws_token'
  const COOKIE_MAX_AGE = 7 * 24 * 60 * 60
  const EVENT_KEY = 'ws_session_event'

  function cookieAttributes(maxAge) {
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    return `Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`))
    return match ? decodeURIComponent(match[1]) : ''
  }

  function token() {
    return localStorage.getItem('ws_token') || localStorage.getItem('authToken') || getCookie(COOKIE_NAME) || ''
  }

  function syncCookie() {
    const storedToken = localStorage.getItem('ws_token') || localStorage.getItem('authToken') || ''
    if (storedToken && getCookie(COOKIE_NAME) !== storedToken) {
      document.cookie = `${COOKIE_NAME}=${encodeURIComponent(storedToken)}; ${cookieAttributes(COOKIE_MAX_AGE)}`
    }
    return storedToken || getCookie(COOKIE_NAME) || ''
  }

  function persist(authToken, user = null) {
    if (!authToken) return clear()
    localStorage.setItem('ws_token', authToken)
    localStorage.setItem('authToken', authToken)
    if (user) localStorage.setItem('ws_user', JSON.stringify(user))
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(authToken)}; ${cookieAttributes(COOKIE_MAX_AGE)}`
    localStorage.setItem(EVENT_KEY, JSON.stringify({ type:'login', at:Date.now() }))
  }

  function clear() {
    localStorage.removeItem('ws_token')
    localStorage.removeItem('authToken')
    localStorage.removeItem('ws_user')
    document.cookie = `${COOKIE_NAME}=; ${cookieAttributes(0)}`
    localStorage.setItem(EVENT_KEY, JSON.stringify({ type:'logout', at:Date.now() }))
  }

  function headers(extra = {}) {
    const current = token()
    return current ? { ...extra, Authorization:`Bearer ${current}` } : { ...extra }
  }

  window.AuthSession = Object.freeze({ token, persist, clear, headers, syncCookie, eventKey:EVENT_KEY })
  syncCookie()
})()
