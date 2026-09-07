export default defineEventHandler(async event => {
  const path = getRouterParam(event, 'path') ?? ''
  if (!/^courses(?:\/[1-9]\d{0,9})?$/.test(path)) throw createError({ statusCode: 404 })
  const config = useRuntimeConfig(event)
  const base = new URL(String(config.learningApiBase))
  const host = new URL(String(config.learningWwwOrigin)).host
  const target = new URL(`/api/v4/learning/${path}`, base)
  const cursor = getQuery(event).cursor
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 32) throw createError({ statusCode: 400 })
    target.searchParams.set('cursor', cursor)
  }
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  return proxyRequest(event, target.href, { headers: { host } })
})
