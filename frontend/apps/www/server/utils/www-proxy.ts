import type { H3Event } from 'h3'

export async function proxyWwwRequest(event: H3Event, path: string, query: Record<string, string> = {}) {
  const config = useRuntimeConfig(event)
  const target = new URL(path, String(config.learningApiBase))
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  // Preserve Location and Set-Cookie for the browser, including single-use OAuth codes.
  return proxyRequest(event, target.href, { headers: { host: new URL(String(config.learningWwwOrigin)).host }, fetchOptions: { redirect: 'manual' } })
}
