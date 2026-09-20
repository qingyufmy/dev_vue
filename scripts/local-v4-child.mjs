import { readFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import { roles } from './lib/local-v4-roles.mjs'
import { localAccountEnvironment } from './run-local-account-api.mjs'

const role = roles.find(item => item.id === process.argv[2])
if (!role) throw new Error('unknown local role')
const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
// IPC invokes the application's existing graceful shutdown, including on Windows.
process.on('message', message => { if (message === 'local-v4-stop') process.emit('SIGTERM') })
process.on('disconnect', () => process.emit('SIGTERM'))
if (role.web) {
  const app = role.id === 'auth-web' ? 'auth' : 'trade'
  const vite = await import(pathToFileURL(resolve(root, 'frontend/apps', app, 'node_modules/vite/dist/node/index.js')))
  const server = await vite.createServer({ root: resolve(root, 'frontend/apps', app), server: { host: '127.0.0.1', port: role.port, strictPort: true } })
  process.once('SIGTERM', () => { void server.close().finally(() => process.exit(0)) })
  await server.listen()
  console.log(`http://localhost:${role.port}`)
} else {
  const base = parse(await readFile(resolve(root, 'server/.env')))
  if (base.MYSQL_HOST !== '192.168.1.254' || base.MYSQL_DATABASE !== 'dev_vue') throw new Error('local development database mismatch')
  const local = parse(await readFile(process.env.LOCAL_V4_ACCOUNT_ENV || resolve(root, '../.local-runtime/dev-vue/account-api.env')))
  Object.assign(process.env, localAccountEnvironment(base, local), { V4_RUNTIME_HOST: '127.0.0.1', V4_BROWSER_REALTIME_PORT: '3011', V4_BRIDGE_GATEWAY_PORT: '3012' })
  await import(pathToFileURL(resolve(root, 'server/dist-v4/entrypoints', `${role.id}.js`)))
}
