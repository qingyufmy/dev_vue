export function hasVideoMedia(item) {
  return Boolean(item?.hasStreamVideo || item?.hasBilibili || item?.hasYoutube)
}

export function getVideoEpisodeIds(items = []) {
  return items.filter(hasVideoMedia).map(item => Number(item.id))
}
