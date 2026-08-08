import http from 'http'
import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFatalProcessHandlers, listenHttpServer } from '../server/runtime-lifecycle.js'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe('runtime lifecycle', () => {
  it('resolves only after the HTTP server is actually listening', async () => {
    const server = http.createServer((req, res) => res.end('ok'))
    servers.push(server)
    await expect(listenHttpServer(server, 0)).resolves.toBe(server)
    expect(server.listening).toBe(true)
  })

  it('rejects a port conflict so workers cannot start after EADDRINUSE', async () => {
    const first = http.createServer()
    servers.push(first)
    await listenHttpServer(first, 0)
    const second = http.createServer()
    await expect(listenHttpServer(second, first.address().port)).rejects.toMatchObject({ code:'EADDRINUSE' })
  })

  it('treats uncaught errors as fatal instead of leaving background work alive', () => {
    const processRef = new EventEmitter()
    processRef.exit = vi.fn()
    const logger = { error:vi.fn() }
    const uninstall = installFatalProcessHandlers({ processRef, logger })
    processRef.emit('uncaughtException', new Error('boom'))
    expect(processRef.exit).toHaveBeenCalledWith(1)
    uninstall()
  })
})
