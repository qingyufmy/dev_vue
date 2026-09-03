-- Bridge V4 device refresh sessions. Write-only migration artifact; do not run from app startup.
-- Existing V3 sessions remain valid during the rollback window and are never revoked here.

ALTER TABLE bridge_refresh_sessions
  ADD COLUMN credential_version TINYINT UNSIGNED NOT NULL DEFAULT 3 AFTER token_hash,
  ADD COLUMN installation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER credential_version,
  ADD COLUMN profile_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER installation_id,
  ADD COLUMN generation INT UNSIGNED NOT NULL DEFAULT 1 AFTER profile_id,
  ADD COLUMN migration_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER generation,
  ADD COLUMN source_fingerprint CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER migration_key,
  ADD COLUMN source_refresh_session_id BIGINT NULL AFTER source_fingerprint,
  ADD UNIQUE INDEX uk_bridge_refresh_migration_key (migration_key),
  ADD UNIQUE INDEX uk_bridge_refresh_source_migration (source_refresh_session_id),
  ADD INDEX idx_bridge_refresh_device
    (user_id, installation_id, profile_id, credential_version, revoked_at, expires_at);
