import { describe, expect, it } from 'vitest'

import { browserWsPerMessageDeflateOptions } from '../../server/bridge-ws.js'

describe('browser websocket compression', () => {
  it('is disabled by default and for non-explicit values', () => {
    expect(browserWsPerMessageDeflateOptions({})).toBe(false)
    expect(browserWsPerMessageDeflateOptions({ BROWSER_WS_PERMESSAGE_DEFLATE: '0' })).toBe(false)
    expect(browserWsPerMessageDeflateOptions({ BROWSER_WS_PERMESSAGE_DEFLATE: 'true' })).toBe(false)
  })

  it('uses bounded no-context-takeover settings when explicitly enabled', () => {
    expect(browserWsPerMessageDeflateOptions({ BROWSER_WS_PERMESSAGE_DEFLATE: ' 1 ' })).toEqual({
      threshold: 1024,
      concurrencyLimit: 4,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
    })
  })
})
