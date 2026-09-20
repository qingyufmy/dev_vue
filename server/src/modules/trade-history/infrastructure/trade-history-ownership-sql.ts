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

// A current account owner may inspect terminal history that predates the
// account's first platform ownership interval. Keep those records unassigned:
// visibility is not attribution, and records proven to another owner remain
// excluded.
export function visibleHistoryRecordSql() {
  return `((r.user_id=? AND ${provenHistoryRecordSql()}) OR
    (r.user_id IS NULL AND r.ownership_interval_id IS NULL
      AND r.evidence_status='complete'
      AND r.opened_at_utc<=r.closed_at_utc AND r.closed_at_utc<=UTC_TIMESTAMP(3)))`
}

export function currentHistoryAccountOwnerSql() {
  return `EXISTS (SELECT 1 FROM users hu
    INNER JOIN trading_account_ownerships ho ON ho.user_id=hu.id
      AND ho.role='owner' AND ho.revoked_at_utc IS NULL
    INNER JOIN trading_accounts ha ON ha.id=ho.trading_account_id
      AND ha.ownership_revision=ho.revision AND ha.deleted_at_utc IS NULL
    INNER JOIN trading_account_ownership_intervals hi ON hi.id=ho.interval_id
      AND hi.user_id=ho.user_id AND hi.trading_account_id=ho.trading_account_id
      AND hi.role='owner' AND hi.ended_at_utc IS NULL
      AND hi.started_at_utc=ho.granted_at_utc AND hi.started_at_utc<=UTC_TIMESTAMP(3)
    WHERE hu.id=? AND hu.deletion_status='active' AND hu.deleted_at IS NULL
      AND ha.id=r.trading_account_id)`
}

export function ownHistoryAccountSql() {
  return `SELECT 1 FROM users hu
    INNER JOIN trading_account_ownerships ho ON ho.user_id=hu.id
      AND ho.trading_account_id=? AND ho.role='owner' AND ho.revoked_at_utc IS NULL
    INNER JOIN trading_accounts ha ON ha.id=ho.trading_account_id
      AND ha.ownership_revision=ho.revision AND ha.deleted_at_utc IS NULL
    INNER JOIN trading_account_ownership_intervals hi ON hi.id=ho.interval_id
      AND hi.user_id=ho.user_id AND hi.trading_account_id=ho.trading_account_id
      AND hi.role='owner' AND hi.ended_at_utc IS NULL
      AND hi.started_at_utc=ho.granted_at_utc AND hi.started_at_utc<=UTC_TIMESTAMP(3)
    WHERE hu.id=? AND hu.deletion_status='active' AND hu.deleted_at IS NULL`
}
