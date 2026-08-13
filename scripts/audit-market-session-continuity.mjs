import '../server/config.js'
import { getDB, queryOne } from '../server/db.js'
import { auditFrozenMarketSessionContinuity } from '../server/routes/ai/frozen-market-diagnostics.js'

function positiveId(flag) {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? Number(process.argv[index + 1]) : null
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

const snapshotId = positiveId('--snapshot-id')
const signalId = positiveId('--signal-id')
if (!snapshotId && !signalId) throw new Error('usage: --snapshot-id <id> or --signal-id <id>')

const row = snapshotId
  ? await queryOne(`SELECT id, signal_id, strategy_id, strategy_version, standard_symbol, market_source,
      klines_json, market_snapshot_json, strategy_runtime_json, content_hash
    FROM inference_snapshots WHERE id = ? LIMIT 1`, [snapshotId])
  : await queryOne(`SELECT id, signal_id, strategy_id, strategy_version, standard_symbol, market_source,
      klines_json, market_snapshot_json, strategy_runtime_json, content_hash
    FROM inference_snapshots WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [signalId])
if (!row) throw new Error('inference_snapshot_not_found')

console.log(JSON.stringify(auditFrozenMarketSessionContinuity(row), null, 2))
await getDB().end()
