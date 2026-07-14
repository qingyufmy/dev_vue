export function hasVideoMedia(item) {
  return Boolean(item?.hasStreamVideo || item?.hasBilibili || item?.hasYoutube)
}

export function getVideoEpisodeIds(items = []) {
  return items.filter(hasVideoMedia).map(item => Number(item.id))
}

export function classifyArticleUrl(value, currentOrigin) {
  const rawUrl = String(value || '').trim()
  if (!rawUrl) return { mode: 'missing', url: '' }

  try {
    const parsed = new URL(rawUrl, currentOrigin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { mode: 'missing', url: '' }
    }
    if (parsed.origin !== currentOrigin) return { mode: 'external', url: parsed.href }
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return { mode: 'missing', url: '' }
    }
    return { mode: 'embedded', url: rawUrl }
  } catch {
    return { mode: 'missing', url: '' }
  }
}
