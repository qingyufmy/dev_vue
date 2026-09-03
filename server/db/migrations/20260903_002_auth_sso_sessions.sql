-- SSO V4 server-side sessions and one-time authorization codes.
-- Write-only migration artifact: it is never executed from application startup.
-- Existing users, password hashes, roles, memberships and token_version values are reused in place.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  client_id ENUM('auth', 'www-web', 'trade-web', 'admin-web') NOT NULL,
  parent_session_id BIGINT UNSIGNED NULL,
  auth_time_utc DATETIME(3) NOT NULL,
  mfa_level ENUM('none', 'otp', 'strong') NOT NULL DEFAULT 'none',
  session_version INT NOT NULL DEFAULT 0,
  created_at_utc DATETIME(3) NOT NULL,
  last_seen_at_utc DATETIME(3) NOT NULL,
  idle_expires_at_utc DATETIME(3) NULL,
  absolute_expires_at_utc DATETIME(3) NOT NULL,
  revoked_at_utc DATETIME(3) NULL,
  revocation_reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_auth_sessions_hash (session_hash),
  KEY idx_auth_sessions_user_active (user_id, revoked_at_utc, absolute_expires_at_utc),
  KEY idx_auth_sessions_parent (parent_session_id),
  KEY idx_auth_sessions_expiry (absolute_expires_at_utc),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_auth_sessions_parent FOREIGN KEY (parent_session_id) REFERENCES auth_sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_authorization_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  auth_session_id BIGINT UNSIGNED NOT NULL,
  client_id ENUM('www-web', 'trade-web', 'admin-web') NOT NULL,
  redirect_uri VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_challenge CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_challenge_method ENUM('S256') NOT NULL DEFAULT 'S256',
  created_at_utc DATETIME(3) NOT NULL,
  expires_at_utc DATETIME(3) NOT NULL,
  consumed_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_auth_codes_hash (code_hash),
  KEY idx_auth_codes_expiry (expires_at_utc),
  KEY idx_auth_codes_session (auth_session_id),
  CONSTRAINT fk_auth_codes_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_auth_codes_session FOREIGN KEY (auth_session_id) REFERENCES auth_sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Operations cleanup should run in bounded batches outside the request process:
-- DELETE FROM auth_authorization_codes WHERE expires_at_utc < UTC_TIMESTAMP(3) - INTERVAL 1 DAY LIMIT 1000;
-- DELETE FROM auth_sessions WHERE absolute_expires_at_utc < UTC_TIMESTAMP(3) - INTERVAL 30 DAY LIMIT 1000;
