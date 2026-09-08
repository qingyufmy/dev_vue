-- Incremental dependencies after completed 036. All four tables start empty.
-- Final 003+021 semantics; no legacy audience grants or live sources inferred.
CREATE TABLE `observer_sources` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `display_name` VARCHAR(80) NOT NULL,
  `notes` VARCHAR(255) NULL,
  `operator_user_id` INT NOT NULL,
  `trading_account_id` BIGINT UNSIGNED NULL,
  `analysis_strategy_id` BIGINT UNSIGNED NULL,
  `status` ENUM('active','disabled') NOT NULL DEFAULT 'disabled',
  `configuration_status` ENUM('pending','ready') NOT NULL DEFAULT 'pending',
  `created_by_user_id` INT NOT NULL,
  `created_at_utc` DATETIME(3) NOT NULL,
  `updated_at_utc` DATETIME(3) NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_observer_source_operator` (`operator_user_id`,`id`),
  KEY `idx_observer_source_account` (`trading_account_id`,`id`),
  CONSTRAINT `fk_observer_source_operator` FOREIGN KEY (`operator_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_observer_source_account` FOREIGN KEY (`trading_account_id`) REFERENCES `trading_accounts` (`id`),
  CONSTRAINT `fk_observer_source_strategy` FOREIGN KEY (`analysis_strategy_id`) REFERENCES `strategies` (`id`),
  CONSTRAINT `fk_observer_source_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_observer_source_ready` CHECK (`configuration_status`<>'ready' OR `trading_account_id` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `observer_channels` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_trading_account_id` BIGINT UNSIGNED NULL,
  `display_name` VARCHAR(128) NOT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 0,
  `created_by_user_id` INT NOT NULL,
  `created_at_utc` DATETIME(3) NOT NULL,
  `source_id` BIGINT UNSIGNED NULL,
  `slug` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `description` VARCHAR(255) NULL,
  `audience` ENUM('all','plus','pro','assigned') NOT NULL DEFAULT 'assigned',
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `default_slot` TINYINT GENERATED ALWAYS AS (CASE WHEN `is_default`=1 THEN 1 ELSE NULL END) STORED,
  `sort_order` INT NOT NULL DEFAULT 0,
  `updated_at_utc` DATETIME(3) NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_observer_channels_active` (`active`,`id`),
  UNIQUE KEY `uk_observer_channel_slug` (`slug`),
  UNIQUE KEY `uk_observer_channel_default` (`default_slot`),
  KEY `idx_observer_channel_source` (`source_id`,`id`),
  CONSTRAINT `fk_observer_channel_account` FOREIGN KEY (`source_trading_account_id`) REFERENCES `trading_accounts` (`id`),
  CONSTRAINT `fk_observer_channel_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_observer_channel_source` FOREIGN KEY (`source_id`) REFERENCES `observer_sources` (`id`),
  CONSTRAINT `chk_observer_channel_default` CHECK (`is_default` IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `observer_channel_accesses` (
  `observer_channel_id` BIGINT UNSIGNED NOT NULL,
  `user_id` INT NOT NULL,
  `granted_at_utc` DATETIME(3) NOT NULL,
  `revoked_at_utc` DATETIME(3) NULL,
  `granted_by_user_id` INT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`observer_channel_id`,`user_id`),
  KEY `idx_observer_access_user` (`user_id`,`revoked_at_utc`,`observer_channel_id`),
  CONSTRAINT `fk_observer_access_channel` FOREIGN KEY (`observer_channel_id`) REFERENCES `observer_channels` (`id`),
  CONSTRAINT `fk_observer_access_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_observer_access_granter` FOREIGN KEY (`granted_by_user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `trading_contexts` (
  `user_id` INT NOT NULL,
  `mode` ENUM('full','observer','blocked') NOT NULL,
  `trading_account_id` BIGINT UNSIGNED NULL,
  `observer_channel_id` BIGINT UNSIGNED NULL,
  `read_only` TINYINT(1) NOT NULL DEFAULT 1,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `updated_at_utc` DATETIME(3) NOT NULL,
  PRIMARY KEY (`user_id`),
  KEY `idx_trading_context_account` (`trading_account_id`,`user_id`),
  CONSTRAINT `fk_trading_context_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_trading_context_account` FOREIGN KEY (`trading_account_id`) REFERENCES `trading_accounts` (`id`),
  CONSTRAINT `fk_trading_context_observer` FOREIGN KEY (`observer_channel_id`) REFERENCES `observer_channels` (`id`),
  CONSTRAINT `chk_trading_context_target` CHECK ((`mode`='full' AND `trading_account_id` IS NOT NULL AND `observer_channel_id` IS NULL) OR (`mode`='observer' AND `trading_account_id` IS NULL AND `observer_channel_id` IS NOT NULL AND `read_only`=1) OR (`mode`='blocked' AND `trading_account_id` IS NULL AND `observer_channel_id` IS NULL AND `read_only`=1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
