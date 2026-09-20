import assert from 'node:assert/strict'
import { loadServerEnvironment } from '../server/dist-v4/bootstrap/index.js'

// Data-only roles: this launcher cannot start trading or order execution workers.
const role = process.argv[2]
assert.ok(['bridge-gateway', 'scheduler-trade-history', 'worker-risk-summary'].includes(role), 'local_data_role_invalid')
loadServerEnvironment()
assert.equal(process.env.MYSQL_HOST, '192.168.1.254', 'local_data_host_invalid')
assert.equal(process.env.MYSQL_DATABASE, 'dev_vue', 'local_data_database_invalid')
process.env.AURUM_V4_RUNTIME_ENABLED = 'true'
process.env.V4_RUNTIME_HOST = '127.0.0.1'
await import(`../server/dist-v4/entrypoints/${role}.js`)
