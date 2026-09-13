import type { H3Event } from 'h3'
import nodeFetch from 'node-fetch-native/node'

export async function proxyWwwRequest(event: H3Event, path: string, query: Record<string, string> = {}) {
  const config = useRuntimeConfig(event)
  const target = new URL(path, String(config.learningApiBase))
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  // Preserve Location and Set-Cookie for the browser, including single-use OAuth codes.
  // Node's native fetch replaces Host with the upstream address. Authentication
  // must receive the configured public www host, not the internal API host.
  return proxyRequest(event, target.href, {
    fetch: nodeFetch,
    headers: { host: new URL(String(config.learningWwwOrigin)).host },
    fetchOptions: { redirect: 'manual' },
  })
}
