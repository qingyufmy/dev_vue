-- Additive prerequisites only. No legacy time conversion, token promotion or deletion.
ALTER TABLE `users` ADD COLUMN `last_seen_at_utc` DATETIME(3) NULL DEFAULT NULL;
ALTER TABLE `users` ADD COLUMN `profile_revision` BIGINT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE `bridge_refresh_sessions` ADD COLUMN `credential_version` TINYINT UNSIGNED NOT NULL DEFAULT 3;
ALTER TABLE `bridge_refresh_sessions` ADD COLUMN `installation_id` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE `bridge_refresh_sessions` ADD COLUMN `profile_id` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE `bridge_refresh_sessions` ADD COLUMN `generation` INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE `bridge_refresh_sessions` ADD COLUMN `migration_key` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE `bridge_refresh_sessions` ADD COLUMN `source_fingerprint` CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE `bridge_refresh_sessions` ADD COLUMN `source_refresh_session_id` BIGINT NULL;
