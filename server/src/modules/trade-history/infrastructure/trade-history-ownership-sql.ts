// Internal, fixed SQL aliases only. Every user-facing record query uses this
// same predicate; a stored user_id alone is not proof of ownership.
export function provenHistoryRecordSql() {
  return `r.ownership_interval_id IS NOT NULL AND r.evidence_status='complete'
    AND r.opened_at_utc<=r.closed_at_utc AND r.closed_at_utc<=UTC_TIMESTAMP(3)
    AND EXISTS (SELECT 1 FROM users hu WHERE hu.id=r.user_id
      AND hu.deletion_status='active' AND hu.deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM trading_account_ownership_intervals hi
      WHERE hi.id=r.ownership_interval_id AND hi.user_id=r.user_id
        AND hi.trading_account_id=r.trading_account_id AND hi.role='owner'
        AND hi.started_at_utc<=r.opened_at_utc
        AND (hi.ended_at_utc IS NULL OR r.closed_at_utc<hi.ended_at_utc)
        AND NOT EXISTS (SELECT 1 FROM trading_account_ownership_intervals hx
          WHERE hx.trading_account_id=hi.trading_account_id AND hx.role='owner' AND hx.id<>hi.id
            AND (hx.ended_at_utc IS NULL OR hx.ended_at_utc>hx.started_at_utc)
            AND hx.started_at_utc<=r.closed_at_utc
            AND (hx.ended_at_utc IS NULL OR hx.ended_at_utc>r.opened_at_utc)))`
}

export function ownHistoryAccountSql() {
  return `SELECT 1 FROM users hu WHERE hu.id=? AND hu.deletion_status='active' AND hu.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM trading_account_ownership_intervals hi
      WHERE hi.user_id=hu.id AND hi.trading_account_id=? AND hi.role='owner'
        AND hi.started_at_utc<=UTC_TIMESTAMP(3)
        AND (hi.ended_at_utc IS NULL OR hi.ended_at_utc>hi.started_at_utc))`
}
