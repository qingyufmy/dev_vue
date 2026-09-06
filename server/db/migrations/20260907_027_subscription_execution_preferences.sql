-- V4 subscription structure only. Never apply to the legacy same-name table.
-- Historical rows are populated by the reconciled migration writer, not defaults.
CREATE TABLE IF NOT EXISTS subscription_execution_preferences_v4 (
  subscription_id BIGINT UNSIGNED NOT NULL,
  contract_version SMALLINT UNSIGNED NOT NULL,
  take_profit_mode ENUM('ai_recommended','conservative','standard','trend') NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (subscription_id),
  CONSTRAINT fk_subscription_execution_preferences_subscription
    FOREIGN KEY (subscription_id) REFERENCES strategy_subscriptions (id),
  CONSTRAINT chk_subscription_execution_preferences_version CHECK (contract_version=1),
  CONSTRAINT chk_subscription_execution_preferences_revision CHECK (revision>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
