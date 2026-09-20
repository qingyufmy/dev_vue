-- Persistent task identity and fencing. Activation follows schema and worker admission.
CREATE TABLE history_collection_tasks_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','running','completing','succeeded','failed') NOT NULL DEFAULT 'pending',
  range_start_utc DATETIME(3) NOT NULL,
  range_end_utc DATETIME(3) NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at_utc DATETIME(3) NULL,
  route_json JSON NULL,
  route_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  completion_json JSON NULL,
  completion_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result_receipt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  active_account_id BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN status IN ('pending','running','completing') THEN trading_account_id ELSE NULL END
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uk_history_task_active_account (active_account_id),
  KEY idx_history_task_recovery (status,lease_expires_at_utc,id),
  KEY idx_history_task_account (trading_account_id,created_at_utc,id),
  CONSTRAINT fk_history_task_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_history_task_receipt FOREIGN KEY (result_receipt_id) REFERENCES terminal_history_collection_receipts_v4 (id),
  CONSTRAINT chk_history_task_window CHECK (range_end_utc>range_start_utc),
  CONSTRAINT chk_history_task_lease CHECK (
    (status IN ('running','completing') AND lease_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
    OR (status NOT IN ('running','completing') AND lease_token IS NULL AND lease_expires_at_utc IS NULL)
  ),
  CONSTRAINT chk_history_task_route CHECK (
    (route_json IS NULL AND route_sha256 IS NULL AND status IN ('pending','failed'))
    OR (route_json IS NOT NULL AND route_sha256 IS NOT NULL AND REGEXP_LIKE(route_sha256,'^[0-9a-f]{64}$','c'))
  ),
  CONSTRAINT chk_history_task_completion CHECK (
    (completion_json IS NULL AND completion_sha256 IS NULL AND status IN ('pending','running','failed'))
    OR (completion_json IS NOT NULL AND completion_sha256 IS NOT NULL AND REGEXP_LIKE(completion_sha256,'^[0-9a-f]{64}$','c') AND status IN ('completing','succeeded','failed'))
  ),
  CONSTRAINT chk_history_task_result CHECK (
    (status IN ('pending','running','completing') AND completed_at_utc IS NULL AND result_receipt_id IS NULL)
    OR (status='succeeded' AND completed_at_utc IS NOT NULL AND result_receipt_id IS NOT NULL)
    OR (status='failed' AND completed_at_utc IS NOT NULL AND result_receipt_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
