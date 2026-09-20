-- Additive installation authority. Existing profile credentials remain independent when parent is NULL.
CREATE TABLE bridge_installation_request_limits (
  ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  window_started_at_utc DATETIME(3) NOT NULL,
  request_count INT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE bridge_installation_authorizations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  installation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_name VARCHAR(120) NOT NULL,
  generation INT UNSIGNED NOT NULL DEFAULT 1,
  created_at_utc DATETIME(3) NOT NULL,
  last_used_at_utc DATETIME(3) NULL,
  revoked_at_utc DATETIME(3) NULL,
  active_installation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (IF(revoked_at_utc IS NULL,installation_id,NULL)) STORED,
  UNIQUE KEY uk_bridge_installation_token (token_hash),
  UNIQUE KEY uk_bridge_installation_active (active_installation_id),
  KEY idx_bridge_installation_identity (installation_id,revoked_at_utc),
  KEY idx_bridge_installation_user (user_id,revoked_at_utc),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE bridge_installation_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_name VARCHAR(120) NOT NULL,
  poll_secret_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  user_id INT NULL,
  decision_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  decided_at_utc DATETIME(3) NULL,
  created_at_utc DATETIME(3) NOT NULL,
  expires_at_utc DATETIME(3) NOT NULL,
  next_poll_at_utc DATETIME(3) NULL,
  UNIQUE KEY uk_bridge_installation_request (request_key),
  UNIQUE KEY uk_bridge_installation_poll (poll_secret_hash),
  KEY idx_bridge_installation_ip (ip_hash,created_at_utc),
  FOREIGN KEY (user_id) REFERENCES users(id),
  CHECK (status IN ('pending','approved','denied','revoked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE bridge_refresh_sessions
  ADD COLUMN installation_authorization_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN installation_request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uk_bridge_installation_profile_request (installation_authorization_id,installation_request_key),
  ADD CONSTRAINT fk_bridge_profile_installation FOREIGN KEY (installation_authorization_id) REFERENCES bridge_installation_authorizations(id);
