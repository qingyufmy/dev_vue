import { getEffectivePlan, isMembershipExpired } from '../../membership.js'

export const PLUS_OBSERVER_TABS = Object.freeze([
  'dashboard', 'ai-analyze', 'trading', 'history', 'feedback',
])

export const PRO_OBSERVER_TABS = Object.freeze([
  'dashboard', 'model-strategy', 'ai-analyze', 'trading', 'history', 'feedback',
])

export const OBSERVER_WS_READ_ACTIONS = Object.freeze(new Set([
  'health', 'account', 'symbols', 'quote', 'positions', 'rates',
  'signals_latest_id', 'signal_detail', 'signal_evidence', 'signals', 'signal_tickets',
  'close_signal_tickets', 'history', 'history_chart_data', 'history_prepare_status_v1', 'pending_list',
  'signal_by_ticket',
]))

const PRO_OBSERVER_HTTP_GET_PATTERNS = Object.freeze([
  /^\/ai\/access-context$/,
  /^\/ai\/observer-channels$/,
  /^\/ai\/strategies(?:\/\d+)?$/,
  /^\/ai\/model-profiles$/,
  /^\/ai\/model-source$/,
  /^\/ai\/platform-model-policy$/,
  /^\/ai\/inference-preferences$/,
])

const PLUS_OBSERVER_HTTP_GET_PATTERNS = Object.freeze([
  /^\/ai\/access-context$/,
  /^\/ai\/observer-channels$/,
])

const BLOCKED_HTTP_GET_PATTERNS = Object.freeze([
  /^\/ai\/access-context$/,
])

const AI_API_PREFIXES = Object.freeze(['/aurum-api', '/api'])

/**
 * Convert a request URL from either API mount point to the route-local path.
 *
 * This intentionally only removes one known prefix at the beginning of the
 * path. Query parameters are ignored for authorization, while encoded or
 * repeated slashes remain untouched so that an unknown path cannot become an
 * allowed observer endpoint through normalization.
 */
export function normalizeAiRequestPath(path) {
  let normalized = String(path || '').split('?')[0]
  if (!normalized) return '/'

  for (const prefix of AI_API_PREFIXES) {
    if (normalized === prefix) {
      normalized = '/'
      break
    }
    if (normalized.startsWith(`${prefix}/`)) {
      normalized = normalized.slice(prefix.length) || '/'
      break
    }
  }

  // Express's default non-strict routing accepts one trailing slash. Do not
  // strip from a repeated suffix (`//`), which must remain an unknown path.
  if (normalized.length > 1 && normalized.endsWith('/') && !normalized.endsWith('//')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized || '/'
}

export function buildAiAccessContext(user, options = {}) {
  const role = String(user?.role || 'user').toLowerCase()
  const plan = getEffectivePlan(user)
  const ownBridgeConnected = options.ownBridgeConnected === true

  if (role === 'admin') {
    return {
      mode: 'full', reason: null, read_only: false, can_download_bridge: true,
      allowed_tabs: null, data_source: 'own_account',
    }
  }

  if (plan === 'plus') {
    return {
      mode: 'observer', reason: 'plus_plan', read_only: true, can_download_bridge: false,
      allowed_tabs: [...PLUS_OBSERVER_TABS], data_source: 'platform_admin_account',
    }
  }

  if (plan === 'pro' && !ownBridgeConnected) {
    return {
      mode: 'observer', reason: 'bridge_offline', read_only: true, can_download_bridge: true,
      allowed_tabs: [...PRO_OBSERVER_TABS], data_source: 'platform_admin_account',
    }
  }

  if (plan === 'pro') return {
    mode: 'full', reason: null, read_only: false, can_download_bridge: true,
    allowed_tabs: null, data_source: 'own_account',
  }

  return {
    mode: 'blocked', reason: isMembershipExpired(user) ? 'membership_expired' : 'membership_required',
    read_only: true, can_download_bridge: false,
    allowed_tabs: [], data_source: 'none',
  }
}

export function observerHttpRequestAllowed(access, method, path) {
  if (!access?.read_only) return true
  if (String(method || 'GET').toUpperCase() !== 'GET') return false
  const normalizedPath = normalizeAiRequestPath(path)
  if (access.mode === 'blocked') {
    return BLOCKED_HTTP_GET_PATTERNS.some(pattern => pattern.test(normalizedPath))
  }
  const patterns = access.reason === 'plus_plan'
    ? PLUS_OBSERVER_HTTP_GET_PATTERNS
    : PRO_OBSERVER_HTTP_GET_PATTERNS
  return patterns.some(pattern => pattern.test(normalizedPath))
}

export function createAiAccessMiddleware({ isBridgeAlive = () => false } = {}) {
  return (req, res, next) => {
    const access = buildAiAccessContext(req.user, {
      ownBridgeConnected: isBridgeAlive(req.user?.id) === true,
    })
    req.aiAccess = access
    const requestPath = req.originalUrl || req.url || ''
    if (observerHttpRequestAllowed(access, req.method, requestPath)) return next()
    return res.status(403).json({
      ok:false,
      error:observerAccessError(access, { page:req.method === 'GET' }),
      code:req.method === 'GET' ? 'observer_page_forbidden' : 'observer_read_only',
      access,
    })
  }
}

export function observerWsActionAllowed(access, action) {
  if (access?.mode === 'blocked') return false
  return !access?.read_only || OBSERVER_WS_READ_ACTIONS.has(String(action || ''))
}

export function observerAccessError(access, { page = false } = {}) {
  if (access?.reason === 'membership_expired') return '会员已过期，请续费后继续使用'
  if (access?.reason === 'membership_required') return '当前会员等级不可使用 AI 交易实验室'
  if (page) return '观摩模式仅可访问当前套餐开放的页面数据'
  return access?.reason === 'bridge_offline'
    ? '当前为观摩模式，请连接 MT5 桥接后再操作'
    : 'Plus 会员为观摩模式，仅支持查看'
}
