-- Explicit empty-database prerequisite, executed BEFORE numbered migrations 001 onward.
-- Structure only: no credentials, users, enabled policies, or runnable jobs are seeded.
-- Existing column names required by current V4 repositories are retained; all DATETIME values use UTC.
-- This is NOT a legacy-data backfill or the final 165-table normalization manifest.

CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT,
  uid VARCHAR(32) NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(20) NULL,
  password VARCHAR(255) NOT NULL,
  nickname VARCHAR(100) NOT NULL DEFAULT '',
  avatar VARCHAR(500) NOT NULL DEFAULT '',
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  plan VARCHAR(20) NOT NULL DEFAULT 'free',
  plan_expires_at DATETIME(3) NULL,
  token_version INT NOT NULL DEFAULT 0,
  deletion_status VARCHAR(24) NOT NULL DEFAULT 'active',
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_v4_users_uid (uid),
  KEY idx_v4_users_email (email),
  KEY idx_v4_users_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bridge_refresh_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  user_agent VARCHAR(255) NULL,
  last_ip VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bridge_refresh_token (token_hash),
  KEY idx_bridge_refresh_user (user_id, revoked_at, expires_at),
  KEY idx_bridge_refresh_expiry (expires_at),
  CONSTRAINT fk_v4_bridge_refresh_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Platform profile owner 0 is retained because the current resolver explicitly requires it.
-- Do not invent a user 0 or add an owner FK that would make platform profiles impossible.
CREATE TABLE ai_model_profiles (
  id INT NOT NULL AUTO_INCREMENT,
  owner_user_id INT NOT NULL,
  scope ENUM('user','platform') NOT NULL,
  provider VARCHAR(64) NOT NULL,
  model_name VARCHAR(191) NOT NULL,
  api_base_url VARCHAR(512) NULL,
  api_key_encrypted TEXT NULL,
  key_version VARCHAR(32) NULL,
  temperature DECIMAL(3,2) NULL,
  max_tokens INT UNSIGNED NULL,
  thinking_enabled TINYINT(1) NOT NULL DEFAULT 0,
  reasoning_effort VARCHAR(16) NULL,
  request_timeout_ms INT UNSIGNED NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'inactive',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_v4_model_profiles_owner (owner_user_id, scope, status, deleted_at, id),
  CONSTRAINT chk_v4_model_profiles_owner CHECK (
    (scope='platform' AND owner_user_id=0) OR (scope='user' AND owner_user_id>0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_model_defaults (
  user_id INT NOT NULL,
  model_profile_id INT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_v4_model_default_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_v4_model_default_profile FOREIGN KEY (model_profile_id) REFERENCES ai_model_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_model_provider_capabilities (
  model_profile_id INT NOT NULL,
  provider VARCHAR(64) NULL,
  model_name VARCHAR(191) NULL,
  api_base_url VARCHAR(512) NULL,
  protocol VARCHAR(32) NULL,
  supports_structured_output TINYINT(1) NOT NULL DEFAULT 0,
  verification_status VARCHAR(24) NOT NULL DEFAULT 'unverified',
  verified_by_user_id INT NULL,
  verified_at_utc DATETIME(3) NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (model_profile_id),
  CONSTRAINT fk_v4_capabilities_profile FOREIGN KEY (model_profile_id) REFERENCES ai_model_profiles (id),
  CONSTRAINT fk_v4_capabilities_verifier FOREIGN KEY (verified_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_model_usage_policy (
  id INT NOT NULL,
  share_for_manual TINYINT(1) NOT NULL DEFAULT 0,
  share_for_auto TINYINT(1) NOT NULL DEFAULT 0,
  share_for_review TINYINT(1) NOT NULL DEFAULT 0,
  share_for_memory_compression TINYINT(1) NOT NULL DEFAULT 0,
  allowed_plans JSON NULL,
  daily_requests_per_user INT UNSIGNED NOT NULL DEFAULT 0,
  daily_tokens_per_user BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_v4_model_policy_singleton CHECK (id=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Strategy is an immutable audit reference here; the strategy table is created in migration 004.
CREATE TABLE ai_model_usage_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  model_profile_id INT NULL,
  credential_source VARCHAR(32) NOT NULL,
  `usage` VARCHAR(32) NOT NULL,
  strategy_id BIGINT UNSIGNED NULL,
  request_phase VARCHAR(16) NOT NULL,
  token_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  request_status VARCHAR(16) NOT NULL,
  error_code VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL,
  request_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  response_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duration_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
  input_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cached_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  provider_request_id VARCHAR(191) NULL,
  accounting_status VARCHAR(24) NOT NULL DEFAULT 'usage_unknown',
  PRIMARY KEY (id),
  KEY idx_v4_model_usage_quota (user_id, credential_source, created_at, request_phase),
  KEY idx_v4_model_usage_recovery (request_status, created_at, id),
  CONSTRAINT fk_v4_model_usage_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_v4_model_usage_profile FOREIGN KEY (model_profile_id) REFERENCES ai_model_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
