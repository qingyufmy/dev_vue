-- Add account ownership lifecycle intervals and retain the current-grant projection.
ALTER TABLE trading_accounts
  ADD COLUMN margin_mode VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  ADD COLUMN ownership_revision BIGINT UNSIGNED NOT NULL DEFAULT 1;

CREATE TABLE trading_account_ownership_intervals (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  role ENUM('owner','observer_source') NOT NULL,
  started_at_utc DATETIME(3) NOT NULL,
  ended_at_utc DATETIME(3) NULL,
  end_reason VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL,
  origin_kind ENUM('legacy','runtime') NOT NULL,
  origin_ref VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  open_owner_account_id BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN role='owner' AND ended_at_utc IS NULL
      THEN trading_account_id
      ELSE NULL END
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ownership_interval_origin (origin_kind, origin_ref),
  UNIQUE KEY uk_ownership_interval_reference (id, user_id, trading_account_id, role),
  UNIQUE KEY uk_ownership_interval_open_owner (open_owner_account_id),
  KEY idx_ownership_intervals_user_account_started (user_id, trading_account_id, started_at_utc, id),
  KEY idx_ownership_intervals_account_started (trading_account_id, started_at_utc, id),
  CONSTRAINT fk_ownership_intervals_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_ownership_intervals_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT chk_ownership_intervals_period CHECK (ended_at_utc IS NULL OR ended_at_utc >= started_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE trading_account_ownerships
  ADD COLUMN interval_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN open_owner_account_id BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN role='owner' AND revoked_at_utc IS NULL
      THEN trading_account_id
      ELSE NULL END
  ) STORED,
  ADD UNIQUE KEY uk_account_owners_open_owner (open_owner_account_id),
  ADD KEY idx_account_owners_interval_fk (interval_id, user_id, trading_account_id, role),
  ADD CONSTRAINT fk_account_owners_interval
    FOREIGN KEY (interval_id, user_id, trading_account_id, role)
    REFERENCES trading_account_ownership_intervals (id, user_id, trading_account_id, role);

CREATE TABLE user_trading_account_settings (
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  nickname VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  review_status VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  observe_status VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  anomaly_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  hidden TINYINT NOT NULL DEFAULT 0,
  connection_paused TINYINT NOT NULL DEFAULT 0,
  legacy_is_deleted TINYINT NULL DEFAULT NULL,
  observed_until_utc DATETIME(3) NULL DEFAULT NULL,
  identity_verified_at_utc DATETIME(3) NULL DEFAULT NULL,
  first_verified_at_utc DATETIME(3) NULL DEFAULT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, trading_account_id),
  KEY idx_user_trading_account_settings_account (trading_account_id, user_id),
  CONSTRAINT fk_user_trading_account_settings_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_user_trading_account_settings_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT chk_user_trading_account_settings_hidden CHECK (hidden IN (0, 1)),
  CONSTRAINT chk_user_trading_account_settings_connection_paused CHECK (connection_paused IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
