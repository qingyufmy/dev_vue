-- Preserve nullable user state and isolate referral accounting from the identity row.
ALTER TABLE users
  ADD COLUMN email_verified TINYINT NULL DEFAULT NULL,
  ADD COLUMN phone_verified TINYINT NULL DEFAULT NULL,
  ADD COLUMN auth_method VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  ADD COLUMN plan_period VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  ADD COLUMN plan_source VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  ADD COLUMN last_seen_at_utc DATETIME(3) NULL DEFAULT NULL,
  ADD COLUMN changelog_seen_version INT NULL DEFAULT NULL,
  ADD COLUMN profile_revision BIGINT UNSIGNED NOT NULL DEFAULT 1;

CREATE TABLE user_referral_accounts (
  user_id INT NOT NULL,
  referral_code VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  referred_by_code VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL,
  referral_credit DECIMAL(20,8) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  KEY idx_user_referral_accounts_referral_code (referral_code),
  CONSTRAINT fk_user_referral_accounts_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
