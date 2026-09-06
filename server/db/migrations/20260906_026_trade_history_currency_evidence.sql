-- Historical money must carry its own unit. Never backfill from current account currency.
ALTER TABLE terminal_history_deals_v4
  ADD COLUMN account_currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN currency_evidence ENUM('unknown','explicit_record') NOT NULL DEFAULT 'unknown',
  ADD CONSTRAINT chk_terminal_deal_currency_evidence CHECK (
    (currency_evidence = 'unknown' AND account_currency IS NULL)
    OR (currency_evidence = 'explicit_record' AND account_currency IS NOT NULL AND CHAR_LENGTH(account_currency) > 0)
  );

ALTER TABLE account_trade_records_v4
  ADD COLUMN account_currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN currency_evidence ENUM('unknown','explicit_record') NOT NULL DEFAULT 'unknown',
  ADD CONSTRAINT chk_account_trade_currency_evidence CHECK (
    (currency_evidence = 'unknown' AND account_currency IS NULL)
    OR (currency_evidence = 'explicit_record' AND account_currency IS NOT NULL AND CHAR_LENGTH(account_currency) > 0)
  );
