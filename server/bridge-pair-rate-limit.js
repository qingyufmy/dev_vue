import rateLimit from 'express-rate-limit'

export function createBridgePairStartLimiter({ windowMs, max }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      code: 'bridge_pair_start_rate_limited',
      error: '授权请求过于频繁，请稍后再试',
    },
  })
}
