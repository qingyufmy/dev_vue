import { hash } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { executionPreferencesMatch, selectSubscriptionTakeProfit } from '../../server/dist-v4/modules/strategies/index.js'

// Convert only the existing V4 execution-preference contract. Memory and risk
// configuration are not silently encoded into these columns or defaulted away.
export function convertSubscriptionExecutionPreferences(row) {
  const source = { take_profit_mode: row.take_profit_mode, created_at: row.created_at, updated_at: row.updated_at }
  if (Object.values(source).some(value => value !== null && typeof value !== 'string')) throw Error('subscription_preferences_source_shape')
  const problems = [], normalizations = []
  const mode = (source.take_profit_mode || 'ai_recommended').trim().toLowerCase()
  if (mode !== source.take_profit_mode) normalizations.push('legacy_take_profit_runtime_normalization')
  const preference = { contractVersion: 1, takeProfitMode: mode, revision: '1' }
  if (!executionPreferencesMatch(preference, preference)) problems.push({ field: 'take_profit_mode', code: 'subscription_take_profit_mode_unknown' })
  const times = {}
  for (const field of ['created_at', 'updated_at']) {
    try {
      if (source[field] === null) throw Error('missing_time')
      times[field] = inspectWallClock(source[field]).canonicalWallClock
    } catch { problems.push({ field, code: 'subscription_preferences_time_invalid' }) }
  }
  return { sourceHash: hash(source), status: problems.length ? 'blocked' : 'converted', problems, normalizations,
    candidate: problems.length ? null : { contract_version: 1, take_profit_mode: mode, revision: '1',
      created_at_utc: times.created_at, updated_at_utc: times.updated_at },
    selection: problems.length ? null : selectSubscriptionTakeProfit(mode, null, [null, null, null]),
    timeBasis: 'user-confirmed-legacy-utc', executable: false }
}
