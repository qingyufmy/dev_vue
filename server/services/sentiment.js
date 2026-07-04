const MARKETS = [
  { name: '现货黄金', slug: 'gold', category: '商品', igPath: '/commodities/markets-commodities/gold' },
  { name: '现货白银', slug: 'silver', category: '商品', igPath: '/commodities/markets-commodities/silver' },
  { name: '美国原油', slug: 'us-crude', category: '商品', igPath: '/commodities/markets-commodities/us-light-crude' },
  { name: '标普500', slug: 'sp500', category: '股指', igPath: '/indices/markets-indices/us-spx-500' },
  { name: '纳斯达克100', slug: 'nasdaq100', category: '股指', igPath: '/indices/markets-indices/us-tech-100' },
  { name: '道琼斯30', slug: 'dj30', category: '股指', igPath: '/indices/markets-indices/wall-street' },
  { name: '德国DAX40', slug: 'dax40', category: '股指', igPath: '/indices/markets-indices/germany-40' },
  { name: '日经225', slug: 'nikkei225', category: '股指', igPath: '/indices/markets-indices/japan-225' },
  { name: '欧元/美元', slug: 'eurusd', category: '外汇', igPath: '/forex/markets-forex/eur-usd' },
  { name: '英镑/美元', slug: 'gbpusd', category: '外汇', igPath: '/forex/markets-forex/gbp-usd' },
  { name: '美元/日元', slug: 'usdjpy', category: '外汇', igPath: '/forex/markets-forex/usd-jpy' },
  { name: '澳元/美元', slug: 'audusd', category: '外汇', igPath: '/forex/markets-forex/aud-usd' },
  { name: '美元/加元', slug: 'usdcad', category: '外汇', igPath: '/forex/markets-forex/usd-cad' },
  { name: '美元/瑞郎', slug: 'usdchf', category: '外汇', igPath: '/forex/markets-forex/usd-chf' },
  { name: '纽元/美元', slug: 'nzdusd', category: '外汇', igPath: '/forex/markets-forex/nzd-usd' },
  { name: '英镑/日元', slug: 'gbpjpy', category: '外汇', igPath: '/forex/markets-forex/gbp-jpy' },
  { name: '欧元/日元', slug: 'eurjpy', category: '外汇', igPath: '/forex/markets-forex/eur-jpy' },
  { name: '澳元/日元', slug: 'audjpy', category: '外汇', igPath: '/forex/markets-forex/aud-jpy' },
  { name: '欧元/英镑', slug: 'eurgbp', category: '外汇', igPath: '/forex/markets-forex/eur-gbp' },
  { name: '美元/离岸人民币', slug: 'usdcnh', category: '外汇', igPath: '/forex/markets-forex/usd-cnh' },
  { name: '欧元/澳元', slug: 'euraud', category: '外汇', igPath: '/forex/markets-forex/eur-aud' },
  { name: '加元/日元', slug: 'cadjpy', category: '外汇', igPath: '/forex/markets-forex/cad-jpy' },
  { name: '纽元/日元', slug: 'nzdjpy', category: '外汇', igPath: '/forex/markets-forex/nzd-jpy' },
]

const IG_BASE = 'https://www.ig.com/en'

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchOneMarket(market) {
  try {
    const res = await fetch(IG_BASE + market.igPath, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.ig.com/',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const match = html.match(/--long-percent:\s*(\d+)%/)
    if (!match) return null
    const longPct = parseInt(match[1], 10)
    return { ...market, longPct, shortPct: 100 - longPct }
  } catch {
    return null
  }
}

export async function fetchSentiment() {
  const results = []
  for (const market of MARKETS) {
    const result = await fetchOneMarket(market)
    results.push(result || { ...market, longPct: null, shortPct: null })
    await sleep(2000 + Math.random() * 3000)
  }
  return results
}
