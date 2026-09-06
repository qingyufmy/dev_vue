-- Same-database working tables for normalized account conversion.
-- No source rename/drop, data import or runtime cutover occurs here.

CREATE TABLE `trading_accounts_v4_build` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `platform` enum('mt4','mt5') COLLATE utf8mb4_unicode_ci NOT NULL,
  `broker_server` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `account_login` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `currency` varchar(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  `updated_at_utc` datetime(3) NOT NULL,
  `deleted_at_utc` datetime(3) DEFAULT NULL,
  `margin_mode` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `ownership_revision` bigint unsigned NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_trading_account_identity` (`platform`,`broker_server`,`account_login`),
  KEY `idx_trading_accounts_active` (`deleted_at_utc`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `trading_account_ownership_intervals_v4_build` (
  `id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` int NOT NULL,
  `trading_account_id` bigint unsigned NOT NULL,
  `role` enum('owner','observer_source') COLLATE utf8mb4_unicode_ci NOT NULL,
  `started_at_utc` datetime(3) NOT NULL,
  `ended_at_utc` datetime(3) DEFAULT NULL,
  `end_reason` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `origin_kind` enum('legacy','runtime') COLLATE utf8mb4_unicode_ci NOT NULL,
  `origin_ref` varchar(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  `updated_at_utc` datetime(3) NOT NULL,
  `open_owner_account_id` bigint unsigned GENERATED ALWAYS AS ((case when ((`role` = _utf8mb4'owner') and (`ended_at_utc` is null)) then `trading_account_id` else NULL end)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ownership_interval_origin` (`origin_kind`,`origin_ref`),
  UNIQUE KEY `uk_ownership_interval_reference` (`id`,`user_id`,`trading_account_id`,`role`),
  UNIQUE KEY `uk_ownership_interval_open_owner` (`open_owner_account_id`),
  KEY `idx_ownership_intervals_user_account_started` (`user_id`,`trading_account_id`,`started_at_utc`,`id`),
  KEY `idx_ownership_intervals_account_started` (`trading_account_id`,`started_at_utc`,`id`),
  CONSTRAINT `fk_ownership_intervals_account` FOREIGN KEY (`trading_account_id`) REFERENCES `trading_accounts_v4_build` (`id`),
  CONSTRAINT `fk_ownership_intervals_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_ownership_intervals_period` CHECK (((`ended_at_utc` is null) or (`ended_at_utc` >= `started_at_utc`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `trading_account_ownerships_v4_build` (
  `user_id` int NOT NULL,
  `trading_account_id` bigint unsigned NOT NULL,
  `role` enum('owner','observer_source') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'owner',
  `granted_at_utc` datetime(3) NOT NULL,
  `revoked_at_utc` datetime(3) DEFAULT NULL,
  `interval_id` char(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `revision` bigint unsigned NOT NULL DEFAULT '1',
  `open_owner_account_id` bigint unsigned GENERATED ALWAYS AS ((case when ((`role` = _utf8mb4'owner') and (`revoked_at_utc` is null)) then `trading_account_id` else NULL end)) STORED,
  PRIMARY KEY (`user_id`,`trading_account_id`,`role`),
  UNIQUE KEY `uk_account_owners_open_owner` (`open_owner_account_id`),
  KEY `idx_account_owners_account` (`trading_account_id`,`revoked_at_utc`,`user_id`),
  KEY `idx_account_owners_interval_fk` (`interval_id`,`user_id`,`trading_account_id`,`role`),
  CONSTRAINT `fk_account_owners_account` FOREIGN KEY (`trading_account_id`) REFERENCES `trading_accounts_v4_build` (`id`),
  CONSTRAINT `fk_account_owners_interval` FOREIGN KEY (`interval_id`, `user_id`, `trading_account_id`, `role`) REFERENCES `trading_account_ownership_intervals_v4_build` (`id`, `user_id`, `trading_account_id`, `role`),
  CONSTRAINT `fk_account_owners_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `user_trading_account_settings_v4_build` (
  `user_id` int NOT NULL,
  `trading_account_id` bigint unsigned NOT NULL,
  `nickname` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `review_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `observe_status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `anomaly_code` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `hidden` tinyint NOT NULL DEFAULT '0',
  `connection_paused` tinyint NOT NULL DEFAULT '0',
  `legacy_is_deleted` tinyint DEFAULT NULL,
  `observed_until_utc` datetime(3) DEFAULT NULL,
  `identity_verified_at_utc` datetime(3) DEFAULT NULL,
  `first_verified_at_utc` datetime(3) DEFAULT NULL,
  `revision` bigint unsigned NOT NULL DEFAULT '1',
  `updated_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`user_id`,`trading_account_id`),
  KEY `idx_user_trading_account_settings_account` (`trading_account_id`,`user_id`),
  CONSTRAINT `fk_user_trading_account_settings_account` FOREIGN KEY (`trading_account_id`) REFERENCES `trading_accounts_v4_build` (`id`),
  CONSTRAINT `fk_user_trading_account_settings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_user_trading_account_settings_connection_paused` CHECK ((`connection_paused` in (0,1))),
  CONSTRAINT `chk_user_trading_account_settings_hidden` CHECK ((`hidden` in (0,1)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
