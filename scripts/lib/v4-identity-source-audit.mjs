import { canonical, exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { decodeIdentitySourceRow } from './v4-identity-values.mjs'
import { inspectUserLifecycle } from './v4-identity-lifecycle.mjs'
import { epochMillisecondsToUtc, inspectWallClock } from './v4-identity-time.mjs'
import { auditOwnershipGraph } from './v4-identity-ownership-audit.mjs'

const scope = ['users', 'verification_codes', 'bridge_device_pairings', 'bridge_refresh_sessions', 'trading_accounts', 'mt5_account_bindings', 'mt5_account_ownership_history', 'bridge_v3_terminal_sessions', 'ai_observer_sources', 'ai_observer_channels', 'ai_observer_channel_assignments']

// Bounded source-only audit. Full table coverage must be proven outside this function.
export function auditIdentitySourceBatch(review, rowsByTable) {
  exactKeys(rowsByTable, scope)
  check(review.executable === false && review.identity.tables.length === scope.length, 'identity_review_invalid')
  check(new Set(review.identity.tables.map(t => t.sourceTable)).size === scope.length, 'identity_review_invalid')
  for (const rows of Object.values(rowsByTable)) check(Array.isArray(rows) && rows.length <= 10000, 'identity_audit_budget_invalid')
  check(Buffer.byteLength(canonical(rowsByTable)) <= 32 * 1024 * 1024, 'identity_audit_budget_invalid')
  const values = {}, timeChecks = [], valueIssues = [], hashes = [], counts = {}
  for (const table of scope) {
    const contract = review.identity.tables.find(t => t.sourceTable === table)
    check(contract, 'identity_review_invalid')
    const seen = new Set()
    values[table] = []; counts[table] = { rows: rowsByTable[table].length, candidateFields: 0, deferredFields: 0, blockedFields: 0 }
    for (const row of rowsByTable[table]) {
      const locatorHash = hash([table, row.pk])
      check(!seen.has(locatorHash), 'identity_source_duplicate_row'); seen.add(locatorHash)
      const decoded = decodeIdentitySourceRow(contract, row)
      values[table].push(decoded.values)
      hashes.push([table, locatorHash, row.sourceHash])
      for (const field of decoded.inspection.fields) {
        counts[table][field.status === 'candidate' ? 'candidateFields' : field.status === 'deferred' ? 'deferredFields' : 'blockedFields']++
        if (field.status === 'blocked') valueIssues.push({ table, locatorHash, column: field.sourceColumn, code: field.code })
      }
      for (const field of contract.fields.filter(f => ['b2.wall-clock', 'b2.epoch-ms'].includes(f.transformId))) {
        try {
          const value = decoded.values[field.sourceColumn]
          check(value !== null || field.sourceNullable, 'identity_null_forbidden')
          const result = field.transformId === 'b2.epoch-ms' ? epochMillisecondsToUtc(value) : inspectWallClock(value)
          timeChecks.push({ table, locatorHash, column: field.sourceColumn, timeResolved: result.timeResolved, code: result.timeResolved ? 'epoch_semantics_valid' : 'historical_time_basis_unverified' })
        } catch (error) {
          timeChecks.push({ table, locatorHash, column: field.sourceColumn, timeResolved: false, code: /^identity_[a-z_]+$/.test(error.code ?? '') ? error.code : 'identity_time_invalid' })
        }
      }
    }
  }
  const lifecycle = values.users.map(u => inspectUserLifecycle({ id: u.id, role: u.role, plan: u.plan, deletionStatus: u.deletion_status, deletedAt: u.deleted_at, tokenVersion: u.token_version }))
  const ownership = auditOwnershipGraph({
    users: values.users.map(u => u.id),
    accounts: values.trading_accounts.map(a => ({ id: a.id, userId: a.user_id, server: a.broker_server, login: a.login_account })),
    intervals: values.mt5_account_ownership_history.map(i => ({ id: i.id, userId: i.user_id, accountId: i.trading_account_id, server: i.broker_server_key, login: i.login_account, startedAt: i.started_at, endedAt: i.ended_at })),
    bindings: values.mt5_account_bindings.map(b => ({ server: b.broker_server_key, login: b.login_account, userId: b.current_user_id, accountId: b.current_trading_account_id })),
  })
  return { reviewHash: hash(review), inputHash: hash(hashes.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0)), counts,
    lifecycle: lifecycle.map(l => ({ locatorHash: hash(['users', [{ type: 'integer', value: l.userId }]]), stateConsistent: l.stateConsistent, issues: l.issues, sourceLoginEligible: l.sourceLoginEligible })),
    ownership, timeChecks, valueIssues, completeSourceVerified: false, readyForBackfill: false }
}
