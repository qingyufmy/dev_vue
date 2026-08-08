const DEFAULT_INTERVAL_MS = 1000
const DEFAULT_FRESH_MS = 2500

function normalizedText(value) {
  return String(value ?? '').trim()
}

function normalizedAccountRef(accountRef = null) {
  if (!accountRef || typeof accountRef !== 'object') return null
  return {
    broker_server:normalizedText(accountRef.broker_server || accountRef.server).toUpperCase(),
    login:normalizedText(accountRef.login || accountRef.login_account),
  }
}

export function observerQuoteFeedKey(descriptor = {}) {
  return JSON.stringify({
    source_user_id:Number(descriptor.sourceUserId) || 0,
    trading_account_id:Number(descriptor.tradingAccountId) || 0,
    terminal_instance_id:normalizedText(descriptor.terminalInstanceId),
    account_ref:normalizedAccountRef(descriptor.accountRef),
    symbol:normalizedText(descriptor.symbol).toUpperCase(),
  })
}

function quoteFeedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function createObserverQuoteFeedManager({
  fetchQuote,
  publish,
  intervalMs = DEFAULT_INTERVAL_MS,
  freshMs = DEFAULT_FRESH_MS,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof fetchQuote !== 'function') throw new TypeError('observer_quote_fetch_required')
  if (typeof publish !== 'function') throw new TypeError('observer_quote_publish_required')

  const feeds = new Map()
  const socketFeeds = new Map()

  function stopFeed(feed) {
    if (feed?.timer) clearIntervalFn(feed.timer)
    feed.timer = null
    feeds.delete(feed.key)
  }

  function unsubscribe(ws) {
    const key = socketFeeds.get(ws)
    if (!key) return false
    socketFeeds.delete(ws)
    const feed = feeds.get(key)
    if (!feed) return true
    feed.subscribers.delete(ws)
    if (feed.subscribers.size === 0) stopFeed(feed)
    return true
  }

  async function poll(feed) {
    if (feed.inFlight) return feed.inFlight
    feed.inFlight = (async () => {
      const quote = await fetchQuote(feed.descriptor)
      if (!quote || quote.status !== 'success') {
        throw quoteFeedError(quote?.code || quote?.error || quote?.message || 'observer_quote_unavailable')
      }
      feed.quote = quote
      feed.receivedAt = now()
      for (const ws of [...feed.subscribers]) {
        let delivered = false
        try { delivered = publish(ws, quote, feed.descriptor) !== false } catch {}
        if (!delivered) unsubscribe(ws)
      }
      return quote
    })().finally(() => { feed.inFlight = null })
    return feed.inFlight
  }

  function startFeed(feed) {
    if (feed.timer) return
    feed.timer = setIntervalFn(() => {
      if (feed.subscribers.size === 0) return stopFeed(feed)
      poll(feed).catch(() => {})
    }, intervalMs)
    feed.timer?.unref?.()
  }

  async function subscribe(ws, descriptor = {}) {
    const key = observerQuoteFeedKey(descriptor)
    if (!Number(descriptor.sourceUserId) || !normalizedText(descriptor.symbol)) {
      throw quoteFeedError('observer_quote_route_invalid')
    }
    if (socketFeeds.get(ws) !== key) unsubscribe(ws)
    let feed = feeds.get(key)
    if (!feed) {
      feed = {
        key,
        descriptor:{
          ...descriptor,
          sourceUserId:Number(descriptor.sourceUserId),
          tradingAccountId:Number(descriptor.tradingAccountId) || null,
          terminalInstanceId:normalizedText(descriptor.terminalInstanceId) || null,
          accountRef:normalizedAccountRef(descriptor.accountRef),
          symbol:normalizedText(descriptor.symbol).toUpperCase(),
        },
        subscribers:new Set(),
        quote:null,
        receivedAt:0,
        inFlight:null,
        timer:null,
      }
      feeds.set(key, feed)
    }
    feed.subscribers.add(ws)
    socketFeeds.set(ws, key)
    startFeed(feed)
    if (feed.quote && now() - feed.receivedAt <= freshMs) return feed.quote
    return poll(feed)
  }

  function latestFor(ws) {
    const feed = feeds.get(socketFeeds.get(ws))
    if (!feed?.quote || now() - feed.receivedAt > freshMs) return null
    return feed.quote
  }

  function matches(ws, descriptor) {
    return socketFeeds.get(ws) === observerQuoteFeedKey(descriptor)
  }

  function close() {
    for (const feed of feeds.values()) {
      if (feed.timer) clearIntervalFn(feed.timer)
    }
    feeds.clear()
    socketFeeds.clear()
  }

  function stats() {
    return [...feeds.values()].map(feed => ({
      key:feed.key,
      subscribers:feed.subscribers.size,
      symbol:feed.descriptor.symbol,
      source_user_id:feed.descriptor.sourceUserId,
      trading_account_id:feed.descriptor.tradingAccountId,
      terminal_instance_id:feed.descriptor.terminalInstanceId,
    }))
  }

  return { subscribe, unsubscribe, latestFor, matches, close, stats }
}
