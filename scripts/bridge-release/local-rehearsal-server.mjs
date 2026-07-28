import express from 'express'
import { mkdir, readdir, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const LOOPBACK_HOST = '127.0.0.1'

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function argumentsMap(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || value == null) fail('local_rehearsal_arguments_invalid')
    result.set(key.slice(2), value)
  }
  return result
}

function required(args, key) {
  const value = String(args.get(key) || '').trim()
  if (!value) fail(`local_rehearsal_${key.replaceAll('-', '_')}_missing`)
  return value
}

function port(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    fail(`local_rehearsal_${name}_invalid`)
  }
  return parsed
}

async function existingDirectory(value, code) {
  const resolved = path.resolve(value)
  const info = await stat(resolved).catch(() => null)
  if (!info?.isDirectory()) fail(code)
  return resolved
}

async function existingFile(value, code) {
  const resolved = path.resolve(value)
  const info = await stat(resolved).catch(() => null)
  if (!info?.isFile()) fail(code)
  return resolved
}

function listen(server, requestedPort) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(requestedPort, LOOPBACK_HOST)
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server?.listening) return resolve()
    server.close(error => error ? reject(error) : resolve())
  })
}

export async function startLocalReleaseRehearsal({
  stateDirectory,
  staticDirectory,
  publicKeyPath,
  releaseToken,
  apiPort = 3101,
  staticPort = 3102,
} = {}) {
  const stateRoot = path.resolve(String(stateDirectory || ''))
  if (!stateDirectory) fail('local_rehearsal_state_directory_missing')
  await mkdir(stateRoot, { recursive:true })
  if ((await readdir(stateRoot)).length > 0) fail('local_rehearsal_state_directory_not_empty')
  const staticRoot = await existingDirectory(
    staticDirectory,
    'local_rehearsal_static_directory_invalid',
  )
  const stateRelativeToStatic = path.relative(staticRoot, stateRoot)
  const staticRelativeToState = path.relative(stateRoot, staticRoot)
  if ((!stateRelativeToStatic.startsWith('..') && !path.isAbsolute(stateRelativeToStatic))
    || (!staticRelativeToState.startsWith('..') && !path.isAbsolute(staticRelativeToState))) {
    fail('local_rehearsal_directories_overlap')
  }
  const publicKey = await existingFile(publicKeyPath, 'local_rehearsal_public_key_invalid')
  if (typeof releaseToken !== 'string' || releaseToken.length < 32) {
    fail('local_rehearsal_release_token_invalid')
  }
  const requestedApiPort = port(apiPort, 'api_port')
  const requestedStaticPort = port(staticPort, 'static_port')
  if (requestedApiPort !== 0 && requestedApiPort === requestedStaticPort) {
    fail('local_rehearsal_ports_conflict')
  }

  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET ||= 'local-release-rehearsal-not-for-production'
  const { createBridgeReleaseRouter } = await import('../../server/routes/bridge-release.js')

  const staticApp = express()
  staticApp.disable('x-powered-by')
  staticApp.get('/health', (_req, res) => res.json({ ok:true, service:'bridge-release-static' }))
  staticApp.use(express.static(staticRoot, {
    dotfiles:'deny',
    etag:true,
    fallthrough:false,
    index:false,
    maxAge:0,
  }))
  staticApp.use((_error, _req, res, _next) => res.status(404).json({ ok:false, error:'not_found' }))

  const apiApp = express()
  apiApp.disable('x-powered-by')
  apiApp.use(express.json({ limit:'256kb' }))
  apiApp.get('/health', (_req, res) => res.json({ ok:true, service:'bridge-release-api' }))
  apiApp.use('/api', createBridgeReleaseRouter({
    manifestPath:path.join(stateRoot, 'current.json'),
    bootstrapManifestPath:path.join(stateRoot, 'bootstrap.json'),
    publicKeyPath:publicKey,
    releaseToken,
    authenticate:(_req, res) => res.status(401).json({ ok:false, error:'unauthorized' }),
    requireAdmin:(_req, res) => res.status(403).json({ ok:false, error:'forbidden' }),
    queryAllFn:async () => [],
    notifyReleaseAvailable:() => 0,
  }))
  apiApp.use((_req, res) => res.status(404).json({ ok:false, error:'not_found' }))
  apiApp.use((_error, _req, res, _next) =>
    res.status(400).json({ ok:false, error:'invalid_request' }))

  const staticServer = http.createServer(staticApp)
  const apiServer = http.createServer(apiApp)
  try {
    const resolvedStaticPort = await listen(staticServer, requestedStaticPort)
    const resolvedApiPort = await listen(apiServer, requestedApiPort)
    let closed = false
    return {
      apiUrl:`http://${LOOPBACK_HOST}:${resolvedApiPort}`,
      staticUrl:`http://${LOOPBACK_HOST}:${resolvedStaticPort}`,
      async close() {
        if (closed) return
        closed = true
        await Promise.all([close(apiServer), close(staticServer)])
      },
    }
  } catch (error) {
    await Promise.allSettled([close(apiServer), close(staticServer)])
    throw error
  }
}

async function main() {
  const args = argumentsMap(process.argv.slice(2))
  const rehearsal = await startLocalReleaseRehearsal({
    stateDirectory:required(args, 'state-directory'),
    staticDirectory:required(args, 'static-directory'),
    publicKeyPath:required(args, 'public-key'),
    releaseToken:process.env.AURUM_BRIDGE_RELEASE_API_TOKEN,
    apiPort:port(args.get('api-port') || '3101', 'api_port'),
    staticPort:port(args.get('static-port') || '3102', 'static_port'),
  })
  process.stdout.write(`${JSON.stringify({
    ok:true,
    operation:'local-rehearsal-server',
    api_url:rehearsal.apiUrl,
    static_url:rehearsal.staticUrl,
  })}\n`)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await rehearsal.close()
    process.exitCode = 0
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({
      ok:false,
      error:error.code || error.message || 'local_rehearsal_failed',
    })}\n`)
    process.exitCode = 1
  })
}
