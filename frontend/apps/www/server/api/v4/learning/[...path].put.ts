import { proxyWwwRequest } from '../../../utils/www-proxy'
export default defineEventHandler(event => {
  const path = getRouterParam(event, 'path') ?? ''
  if (!/^courses\/[1-9][0-9]{0,9}\/lessons\/[1-9][0-9]{0,9}\/completion$/.test(path)) throw createError({ statusCode: 404 })
  if (Object.keys(getQuery(event)).length) throw createError({ statusCode: 400 })
  return proxyWwwRequest(event, `/api/v4/learning/${path}`)
})
