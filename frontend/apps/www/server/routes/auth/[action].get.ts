import { proxyWwwRequest } from '../../utils/www-proxy'
export default defineEventHandler(event => {
  const action = getRouterParam(event, 'action')
  if (action !== 'start' && action !== 'callback') throw createError({ statusCode: 404 })
  const input = getQuery(event), query: Record<string, string> = {}
  for (const key of action === 'start' ? ['next'] : ['code', 'state']) {
    const value = input[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 4096) throw createError({ statusCode: 400 })
      query[key] = value
    }
  }
  return proxyWwwRequest(event, `/auth/${action}`, query)
})
