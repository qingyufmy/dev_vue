-- In-place foundation tables. Empty structures only; no credentials or grants are activated.
-- Canonical MySQL definitions inspected from the verified V4 reference database.

CREATE TABLE `auth_sessions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `session_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` int NOT NULL,
  `client_id` enum('auth','www-web','trade-web','admin-web') COLLATE utf8mb4_unicode_ci NOT NULL,
  `parent_session_id` bigint unsigned DEFAULT NULL,
  `auth_time_utc` datetime(3) NOT NULL,
  `mfa_level` enum('none','otp','strong') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'none',
  `session_version` int NOT NULL DEFAULT '0',
  `created_at_utc` datetime(3) NOT NULL,
  `last_seen_at_utc` datetime(3) NOT NULL,
  `idle_expires_at_utc` datetime(3) DEFAULT NULL,
  `absolute_expires_at_utc` datetime(3) NOT NULL,
  `revoked_at_utc` datetime(3) DEFAULT NULL,
  `revocation_reason` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_auth_sessions_hash` (`session_hash`),
  KEY `idx_auth_sessions_user_active` (`user_id`,`revoked_at_utc`,`absolute_expires_at_utc`),
  KEY `idx_auth_sessions_parent` (`parent_session_id`),
  KEY `idx_auth_sessions_expiry` (`absolute_expires_at_utc`),
  CONSTRAINT `fk_auth_sessions_parent` FOREIGN KEY (`parent_session_id`) REFERENCES `auth_sessions` (`id`),
  CONSTRAINT `fk_auth_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `auth_authorization_codes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `code_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` int NOT NULL,
  `auth_session_id` bigint unsigned NOT NULL,
  `client_id` enum('www-web','trade-web','admin-web') COLLATE utf8mb4_unicode_ci NOT NULL,
  `redirect_uri` varchar(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `scope` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `nonce` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code_challenge` char(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code_challenge_method` enum('S256') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'S256',
  `created_at_utc` datetime(3) NOT NULL,
  `expires_at_utc` datetime(3) NOT NULL,
  `consumed_at_utc` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_auth_codes_hash` (`code_hash`),
  KEY `idx_auth_codes_expiry` (`expires_at_utc`),
  KEY `idx_auth_codes_session` (`auth_session_id`),
  KEY `fk_auth_codes_user` (`user_id`),
  CONSTRAINT `fk_auth_codes_session` FOREIGN KEY (`auth_session_id`) REFERENCES `auth_sessions` (`id`),
  CONSTRAINT `fk_auth_codes_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `terminal_profiles` (
  `id` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` int NOT NULL,
  `display_name` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `platform` enum('mt4','mt5') COLLATE utf8mb4_unicode_ci NOT NULL,
  `installation_id` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  `updated_at_utc` datetime(3) NOT NULL,
  `deleted_at_utc` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_terminal_profile_install` (`user_id`,`installation_id`,`id`),
  KEY `idx_terminal_profiles_user` (`user_id`,`deleted_at_utc`,`updated_at_utc`),
  CONSTRAINT `fk_terminal_profiles_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `bridge_connection_capacity_grants` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `quantity` int unsigned NOT NULL,
  `source_type` enum('purchase','admin','migration') COLLATE utf8mb4_unicode_ci NOT NULL,
  `source_id` varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `starts_at_utc` datetime(3) NOT NULL,
  `expires_at_utc` datetime(3) DEFAULT NULL,
  `revoked_at_utc` datetime(3) DEFAULT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bridge_capacity_source` (`source_type`,`source_id`),
  KEY `idx_bridge_capacity_active` (`user_id`,`revoked_at_utc`,`starts_at_utc`,`expires_at_utc`),
  CONSTRAINT `fk_bridge_capacity_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `data_migration_runs` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `bindings_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `bindings_json` json NOT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `data_migration_checkpoints` (
  `run_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stream_id` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sequence_number` bigint unsigned NOT NULL DEFAULT '0',
  `cursor_json` json DEFAULT NULL,
  `processed_rows` bigint unsigned NOT NULL DEFAULT '0',
  `updated_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`run_id`,`stream_id`),
  CONSTRAINT `fk_data_checkpoint_run` FOREIGN KEY (`run_id`) REFERENCES `data_migration_runs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `data_migration_batches` (
  `run_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `batch_id` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stream_id` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sequence_number` bigint unsigned NOT NULL,
  `request_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `row_count` int unsigned NOT NULL,
  `end_cursor_json` json NOT NULL,
  `recorded_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`run_id`,`batch_id`),
  UNIQUE KEY `uk_data_batch_sequence` (`run_id`,`stream_id`,`sequence_number`),
  CONSTRAINT `fk_data_batch_run` FOREIGN KEY (`run_id`) REFERENCES `data_migration_runs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `data_migration_id_maps` (
  `logical_source_id` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `entity_kind` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_table` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_pk_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_pk_json` json NOT NULL,
  `target_json` json NOT NULL,
  `created_run_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`logical_source_id`,`entity_kind`,`source_table`,`source_pk_sha256`),
  KEY `fk_data_id_map_run` (`created_run_id`),
  CONSTRAINT `fk_data_id_map_run` FOREIGN KEY (`created_run_id`) REFERENCES `data_migration_runs` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `data_migration_row_receipts` (
  `run_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stream_id` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_pk_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `batch_id` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_pk_json` json NOT NULL,
  `source_bytes_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `transformed_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `targets_json` json NOT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`run_id`,`stream_id`,`source_pk_sha256`),
  KEY `fk_data_receipt_batch` (`run_id`,`batch_id`),
  CONSTRAINT `fk_data_receipt_batch` FOREIGN KEY (`run_id`, `batch_id`) REFERENCES `data_migration_batches` (`run_id`, `batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
