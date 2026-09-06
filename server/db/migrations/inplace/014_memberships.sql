-- Current membership state only; never manufacture historical purchases or grants.
-- Pending real reference-schema verification and coordinator registration.
CREATE TABLE `memberships` (
  user_id INT NOT NULL,
  plan_code VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  billing_period_code VARCHAR(20) NULL,
  source_code VARCHAR(20) NULL,
  expiration_kind VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at_utc DATETIME(3) NULL,
  current_state_observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  PRIMARY KEY (user_id),
  KEY idx_membership_expiry (expiration_kind, expires_at_utc, user_id),
  CONSTRAINT fk_membership_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_membership_migration FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs (id),
  CONSTRAINT ck_membership_plan CHECK (plan_code IN ('free', 'plus', 'pro')),
  CONSTRAINT ck_membership_expiration CHECK (
    (expiration_kind = 'no_expiry' AND expires_at_utc IS NULL)
    OR (expiration_kind = 'at_time' AND expires_at_utc IS NOT NULL)
  ),
  CONSTRAINT ck_membership_revision CHECK (revision > 0),
  CONSTRAINT ck_membership_origin CHECK (
    (origin = 'legacy_import' AND migration_run_id IS NOT NULL AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL)
    OR (origin = 'native' AND migration_run_id IS NULL AND source_sha256 IS NULL AND imported_at_utc IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
