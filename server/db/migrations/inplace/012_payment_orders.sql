-- Target order facts. Backfill requires proven UTC times and verified ID mappings.
-- Pending schema rehearsal and coordinator registration; never run at app startup.
CREATE TABLE `payment_orders` (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  order_number VARCHAR(100) NOT NULL,
  external_order_id VARCHAR(100) NULL,
  product_code VARCHAR(50) NOT NULL,
  product_label VARCHAR(50) NULL,
  billing_period_code VARCHAR(20) NULL,
  billing_period_label VARCHAR(50) NULL,
  order_amount DECIMAL(20,8) NOT NULL,
  legacy_amount_confirmed DECIMAL(20,8) NULL,
  referral_credit_applied DECIMAL(20,8) NOT NULL,
  currency_code VARCHAR(10) NULL,
  status VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status_label VARCHAR(50) NULL,
  payment_method_code VARCHAR(50) NULL,
  created_at_utc DATETIME(3) NOT NULL,
  paid_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  legacy_order_id INT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_order_number (order_number),
  UNIQUE KEY uq_payment_order_external (external_order_id),
  UNIQUE KEY uq_payment_order_legacy (legacy_order_id),
  UNIQUE KEY uq_payment_order_owner (id, user_id),
  KEY idx_payment_order_user_created (user_id, created_at_utc, id),
  KEY idx_payment_order_status_created (status, created_at_utc, id),
  CONSTRAINT fk_payment_order_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_payment_order_migration FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs (id),
  CONSTRAINT ck_payment_order_amount CHECK (
    order_amount >= 0 AND referral_credit_applied >= 0 AND referral_credit_applied <= order_amount
    AND (legacy_amount_confirmed IS NULL OR legacy_amount_confirmed >= 0)
  ),
  CONSTRAINT ck_payment_order_status CHECK (status IN ('pending', 'paid', 'cancelled', 'expired')),
  CONSTRAINT ck_payment_order_paid_time CHECK (status <> 'paid' OR paid_at_utc IS NOT NULL),
  CONSTRAINT ck_payment_order_revision CHECK (revision > 0),
  CONSTRAINT ck_payment_order_origin CHECK (
    (origin = 'legacy_import' AND legacy_order_id IS NOT NULL AND legacy_order_id > 0
      AND migration_run_id IS NOT NULL AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL
      AND legacy_amount_confirmed IS NOT NULL)
    OR (origin = 'native' AND legacy_order_id IS NULL AND migration_run_id IS NULL
      AND source_sha256 IS NULL AND imported_at_utc IS NULL AND legacy_amount_confirmed IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
