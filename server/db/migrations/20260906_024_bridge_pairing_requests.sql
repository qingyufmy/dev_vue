-- New V4 pairing only. Does not consume or rewrite legacy pairing records.
CREATE TABLE bridge_v4_pairing_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  refresh_session_id BIGINT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  expires_at_utc DATETIME(3) NOT NULL,
  consumed_at_utc DATETIME(3) NULL,
  revoked_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bridge_v4_pair_request (user_id, request_key),
  UNIQUE KEY uk_bridge_v4_pair_code (code_hash),
  UNIQUE KEY uk_bridge_v4_pair_profile (profile_id),
  KEY idx_bridge_v4_pair_user_time (user_id, created_at_utc),
  KEY idx_bridge_v4_pair_expiry (expires_at_utc),
  CONSTRAINT fk_bridge_v4_pair_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_bridge_v4_pair_refresh FOREIGN KEY (refresh_session_id) REFERENCES bridge_refresh_sessions (id),
  CONSTRAINT chk_bridge_v4_pair_consumed CHECK (
    (consumed_at_utc IS NULL AND installation_id IS NULL AND refresh_session_id IS NULL)
    OR (consumed_at_utc IS NOT NULL AND installation_id IS NOT NULL AND refresh_session_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
