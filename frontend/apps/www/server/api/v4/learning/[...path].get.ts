import { proxyWwwRequest } from '../../../utils/www-proxy'
export default defineEventHandler(async event => {
  const path = getRouterParam(event, 'path') ?? ''
  if (!/^courses(?:\/[1-9]\d{0,9})?$/.test(path)) throw createError({ statusCode: 404 })
  const query: Record<string, string> = {}
  const cursor = getQuery(event).cursor
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 32) throw createError({ statusCode: 400 })
    query.cursor = cursor
  }
  return proxyWwwRequest(event, `/api/v4/learning/${path}`, query)
})
