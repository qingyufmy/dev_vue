export function getCoursesForCategory(courses, category) {
  return (Array.isArray(courses) ? courses : [])
    .filter(course => course?.category === category)
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '') || 0
      const bTime = Date.parse(b.createdAt || '') || 0
      return bTime - aTime || Number(b.id || 0) - Number(a.id || 0)
    })
}

export function getCoursePage(courses, category, offset = 0, limit = 9) {
  const filtered = getCoursesForCategory(courses, category)
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0)
  const safeLimit = Math.max(1, Number.parseInt(limit, 10) || 9)
  const items = filtered.slice(safeOffset, safeOffset + safeLimit)
  const nextOffset = safeOffset + items.length

  return {
    items,
    total: filtered.length,
    nextOffset,
    hasMore: nextOffset < filtered.length,
  }
}
