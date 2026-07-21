export const PLUS_OBSERVER_TABS = Object.freeze([
  'dashboard', 'signals', 'ai-analyze', 'trading', 'history',
])

export const PRO_OBSERVER_TABS = Object.freeze([
  'dashboard', 'signals', 'model-strategy', 'ai-analyze', 'trading', 'history',
])

export const OBSERVER_WS_READ_ACTIONS = Object.freeze(new Set([
  'health', 'account', 'symbols', 'quote', 'positions', 'rates',
  'signals_latest_id', 'signal_detail', 'signals', 'signal_tickets',
  'close_signal_tickets', 'history', 'history_chart_data', 'pending_list',
  'signal_by_ticket',
]))

const PRO_OBSERVER_HTTP_GET_PATTERNS = Object.freeze([
  /^\/ai\/access-context$/,
  /^\/ai\/strategies(?:\/\d+)?$/,
  /^\/ai\/model-profiles$/,
  /^\/ai\/model-source$/,
  /^\/ai\/platform-model-policy$/,
  /^\/ai\/inference-preferences$/,
])

const PLUS_OBSERVER_HTTP_GET_PATTERNS = Object.freeze([
  /^\/ai\/access-context$/,
])

export function buildAiAccessContext(user, options = {}) {
  const role = String(user?.role || 'user').toLowerCase()
  const plan = String(user?.plan || 'free').toLowerCase()
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

  return {
    mode: 'full', reason: null, read_only: false, can_download_bridge: plan === 'pro',
    allowed_tabs: null, data_source: 'own_account',
  }
}

export function observerHttpRequestAllowed(access, method, path) {
  if (!access?.read_only) return true
  if (String(method || 'GET').toUpperCase() !== 'GET') return false
  const patterns = access.reason === 'plus_plan'
    ? PLUS_OBSERVER_HTTP_GET_PATTERNS
    : PRO_OBSERVER_HTTP_GET_PATTERNS
  return patterns.some(pattern => pattern.test(String(path || '').split('?')[0]))
}

export function observerWsActionAllowed(access, action) {
  return !access?.read_only || OBSERVER_WS_READ_ACTIONS.has(String(action || ''))
}

export function observerAccessError(access, { page = false } = {}) {
  if (page) return '观摩模式仅可访问当前套餐开放的页面数据'
  return access?.reason === 'bridge_offline'
    ? '当前为观摩模式，请连接 MT5 桥接后再操作'
    : 'Plus 会员为观摩模式，仅支持查看'
}
