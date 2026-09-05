-- P3 expansion only: old rows keep their values but lack proof until reconciled.
CREATE TABLE trading_projection_provenance_v4 (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  resource_kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  ownership_interval_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ownership_revision BIGINT UNSIGNED NOT NULL,
  terminal_profile_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terminal_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connection_epoch BIGINT UNSIGNED NOT NULL,
  projection_revision BIGINT UNSIGNED NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, resource_kind, resource_id),
  KEY idx_projection_provenance_interval (ownership_interval_id),
  CONSTRAINT fk_projection_provenance_revision FOREIGN KEY (trading_account_id, resource_kind, resource_id)
    REFERENCES trading_projection_revisions (trading_account_id, resource_kind, resource_id),
  CONSTRAINT fk_projection_provenance_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_projection_provenance_interval FOREIGN KEY (ownership_interval_id) REFERENCES trading_account_ownership_intervals (id),
  CONSTRAINT fk_projection_provenance_profile FOREIGN KEY (terminal_profile_id) REFERENCES terminal_profiles (id),
  CONSTRAINT chk_projection_provenance_kind CHECK (resource_kind IN ('account.metrics','positions','pending_orders'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE account_trade_records_v4
  MODIFY COLUMN user_id INT NULL,
  ADD COLUMN ownership_interval_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD KEY idx_trade_record_ownership_interval (ownership_interval_id),
  ADD CONSTRAINT fk_trade_record_ownership_interval FOREIGN KEY (ownership_interval_id)
    REFERENCES trading_account_ownership_intervals (id);
