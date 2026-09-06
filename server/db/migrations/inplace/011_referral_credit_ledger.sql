-- Pending rehearsal and registry integration. Opening is an observed balance, not a historical credit.
CREATE TABLE referral_credit_ledger (
  user_id INT NOT NULL,
  account_revision BIGINT UNSIGNED NOT NULL,
  event_kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  previous_balance DECIMAL(20,8) NULL,
  delta DECIMAL(20,8) NULL,
  resulting_balance DECIMAL(20,8) NOT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recorded_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, account_revision),
  UNIQUE KEY uq_referral_credit_event (user_id, event_kind, source_key),
  CONSTRAINT fk_referral_ledger_account FOREIGN KEY (user_id) REFERENCES user_referral_accounts (user_id),
  CONSTRAINT fk_referral_ledger_run FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs (id),
  CONSTRAINT ck_referral_ledger_kind CHECK (event_kind IN ('opening', 'order_debit', 'order_release', 'commission_credit')),
  CONSTRAINT ck_referral_ledger_shape CHECK (
    (event_kind = 'opening' AND account_revision = 1 AND previous_balance IS NULL AND delta IS NULL AND migration_run_id IS NOT NULL)
    OR
    (event_kind <> 'opening' AND account_revision > 1 AND previous_balance IS NOT NULL AND delta IS NOT NULL AND migration_run_id IS NULL)
  ),
  CONSTRAINT ck_referral_ledger_amount CHECK (
    event_kind = 'opening' OR
    (resulting_balance = previous_balance + delta AND
      ((event_kind = 'order_debit' AND delta < 0 AND resulting_balance >= 0) OR
       (event_kind IN ('order_release', 'commission_credit') AND delta > 0)))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
