import { sha256 } from './v4-migration-plan.mjs'

const tables = Object.freeze({
  payment_transactions: 'id,chain,transaction_hash,asset_contract,asset_code,recipient_address,received_amount,occurred_at_utc,first_observed_at_utc,last_observed_at_utc,confirmations,revision,evidence_sha256',
  payment_matches: 'id,payment_order_id,user_id,chain,asset_contract,recipient_address,expected_amount,required_confirmations,payment_transaction_id,status,window_start_at_utc,expires_at_utc,created_at_utc,revision,origin,legacy_watch_id,legacy_confirmations,legacy_wallet_index,migration_run_id,source_sha256,imported_at_utc',
  memberships: 'user_id,plan_code,billing_period_code,source_code,expiration_kind,expires_at_utc,current_state_observed_at_utc,revision,origin,migration_run_id,source_sha256,imported_at_utc',
})
export async function readMembershipUpgradeRows(connection) {
  const result = {}
  for (const [table, fields] of Object.entries(tables)) {
    const [[exists]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
    if (Number(exists.n) === 0) { result[table] = null; continue }
    const [rows] = await connection.query(`SELECT ${fields} FROM ${table} ORDER BY ${table === 'memberships' ? 'user_id' : 'id'}`)
    result[table] = { rows: rows.length, hash: sha256(JSON.stringify(rows)) }
  }
  return result
}
export function verifyMembershipUpgradeRows(before, after) {
  for (const table of Object.keys(tables)) {
    if (before[table] !== null && JSON.stringify(before[table]) !== JSON.stringify(after[table])) throw new Error('inplace_membership_rows_changed')
  }
}
