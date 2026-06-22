// 侧边栏"最近更新" —— 直接从 courses 表取最新 5 门课

/**
 * 从 API 加载最近更新的课程（只取 5 条）。
 */
export async function loadSiteUpdates(limit = 5) {
  try {
    const res = await fetch(`/api/site-updates?limit=${limit}`)
    const data = await res.json()
    if (data.ok && Array.isArray(data.items)) {
      return data.items
    }
  } catch (_) { /* 网络错误 */ }
  return []
}
