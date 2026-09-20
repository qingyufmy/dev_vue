import assert from 'node:assert/strict'
import { loadServerEnvironment } from '../server/dist-v4/bootstrap/index.js'
const role = process.argv[2]
assert.ok(['worker-trader', 'worker-risk', 'worker-execution'].includes(role), 'local_trading_role_invalid')
loadServerEnvironment()
assert.equal(process.env.MYSQL_HOST, '192.168.1.254')
assert.equal(process.env.MYSQL_DATABASE, 'dev_vue')
process.env.AURUM_V4_RUNTIME_ENABLED = 'true'
process.env.V4_RUNTIME_HOST = '127.0.0.1'
await import(`../server/dist-v4/entrypoints/${role}.js`)
