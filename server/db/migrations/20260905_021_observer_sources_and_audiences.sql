-- P4A expansion only. No audience grants, sources or legacy mappings are seeded.
CREATE TABLE observer_sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  display_name VARCHAR(80) NOT NULL,
  notes VARCHAR(255) NULL,
  operator_user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NULL,
  analysis_strategy_id BIGINT UNSIGNED NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'disabled',
  configuration_status ENUM('pending','ready') NOT NULL DEFAULT 'pending',
  created_by_user_id INT NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_observer_source_operator (operator_user_id,id),
  KEY idx_observer_source_account (trading_account_id,id),
  CONSTRAINT fk_observer_source_operator FOREIGN KEY (operator_user_id) REFERENCES users (id),
  CONSTRAINT fk_observer_source_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_observer_source_strategy FOREIGN KEY (analysis_strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_observer_source_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_observer_source_ready CHECK (configuration_status<>'ready' OR trading_account_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE observer_channels
  MODIFY COLUMN source_trading_account_id BIGINT UNSIGNED NULL,
  MODIFY COLUMN active TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN source_id BIGINT UNSIGNED NULL,
  ADD COLUMN slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN description VARCHAR(255) NULL,
  ADD COLUMN audience ENUM('all','plus','pro','assigned') NOT NULL DEFAULT 'assigned',
  ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN default_slot TINYINT GENERATED ALWAYS AS (CASE WHEN is_default=1 THEN 1 ELSE NULL END) STORED,
  ADD COLUMN sort_order INT NOT NULL DEFAULT 0,
  ADD COLUMN updated_at_utc DATETIME(3) NULL,
  ADD COLUMN revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  ADD UNIQUE KEY uk_observer_channel_slug (slug),
  ADD UNIQUE KEY uk_observer_channel_default (default_slot),
  ADD KEY idx_observer_channel_source (source_id,id),
  ADD CONSTRAINT fk_observer_channel_source FOREIGN KEY (source_id) REFERENCES observer_sources (id),
  ADD CONSTRAINT chk_observer_channel_default CHECK (is_default IN (0,1));

ALTER TABLE observer_channel_accesses
  ADD COLUMN granted_by_user_id INT NULL,
  ADD COLUMN revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  ADD CONSTRAINT fk_observer_access_granter FOREIGN KEY (granted_by_user_id) REFERENCES users (id);
