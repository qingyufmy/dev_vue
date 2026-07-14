const BASE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.hdslb.com https://i0.hdslb.com https://i1.hdslb.com https://i2.hdslb.com; font-src 'self' data:; connect-src 'self' wss: ws:"

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', BASE_CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.removeHeader('X-Powered-By')
  next()
}
