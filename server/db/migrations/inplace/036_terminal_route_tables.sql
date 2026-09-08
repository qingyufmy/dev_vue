-- Incremental account sample dependency, after completed account-root promotion (035).
-- Applied only by the dedicated journaled coordinator, never application startup.
-- Existing legacy bindings/sessions are retained. No live route is inferred from legacy facts.
CREATE TABLE `terminal_account_bindings` (
  `terminal_profile_id` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `trading_account_id` BIGINT UNSIGNED NOT NULL,
  `terminal_instance_id` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `bound_at_utc` DATETIME(3) NOT NULL,
  `unbound_at_utc` DATETIME(3) NULL,
  PRIMARY KEY (`terminal_profile_id`,`trading_account_id`,`bound_at_utc`),
  KEY `idx_terminal_bindings_route` (`trading_account_id`,`unbound_at_utc`,`terminal_instance_id`),
  CONSTRAINT `fk_terminal_bindings_profile` FOREIGN KEY (`terminal_profile_id`) REFERENCES `terminal_profiles` (`id`),
  CONSTRAINT `fk_terminal_bindings_account` FOREIGN KEY (`trading_account_id`) REFERENCES `trading_accounts` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `bridge_connection_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `trading_account_id` BIGINT UNSIGNED NOT NULL,
  `terminal_profile_id` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `terminal_instance_id` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `connection_epoch` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `connection_epoch_v4` BIGINT UNSIGNED NULL,
  `connected_at_utc` DATETIME(3) NOT NULL,
  `last_seen_at_utc` DATETIME(3) NOT NULL,
  `disconnected_at_utc` DATETIME(3) NULL,
  `disconnect_reason` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bridge_connection_route_epoch` (`terminal_instance_id`,`connection_epoch`),
  KEY `idx_bridge_connection_profile_epoch_v4` (`user_id`,`terminal_profile_id`,`connection_epoch_v4`),
  KEY `idx_bridge_sessions_user_online` (`user_id`,`disconnected_at_utc`,`last_seen_at_utc`),
  KEY `idx_bridge_sessions_route` (`trading_account_id`,`disconnected_at_utc`,`connected_at_utc`),
  CONSTRAINT `fk_bridge_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_bridge_sessions_account` FOREIGN KEY (`trading_account_id`) REFERENCES `trading_accounts` (`id`),
  CONSTRAINT `fk_bridge_sessions_profile` FOREIGN KEY (`terminal_profile_id`) REFERENCES `terminal_profiles` (`id`),
  CONSTRAINT `chk_bridge_connection_epoch_v4_safe` CHECK (`connection_epoch_v4` IS NULL OR `connection_epoch_v4` BETWEEN 1 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
