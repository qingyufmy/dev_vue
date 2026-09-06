CREATE TABLE `strategies` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `kind` enum('analysis','trader') COLLATE utf8mb4_unicode_ci NOT NULL,
  `scope` enum('platform','user') COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` int DEFAULT NULL,
  `name` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(2000) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `status` enum('draft','active','retired') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',
  `active_version_id` bigint unsigned DEFAULT NULL,
  `revision` bigint unsigned NOT NULL DEFAULT '1',
  `legacy_source_table` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `legacy_id` varchar(191) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  `updated_at_utc` datetime(3) NOT NULL,
  `deleted_at_utc` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_strategies_legacy` (`legacy_source_table`,`legacy_id`),
  KEY `idx_strategies_catalog` (`kind`,`status`,`scope`,`owner_user_id`,`deleted_at_utc`,`id`),
  KEY `fk_strategies_owner` (`owner_user_id`),
  KEY `fk_strategies_active_version` (`active_version_id`,`id`),
  CONSTRAINT `fk_strategies_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_strategies_owner` CHECK ((((`scope` = _utf8mb4'platform') and (`owner_user_id` is null)) or ((`scope` = _utf8mb4'user') and (`owner_user_id` is not null))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `strategy_versions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `strategy_id` bigint unsigned NOT NULL,
  `version_number` int unsigned NOT NULL,
  `prompt_text` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `prompt_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `input_contract_version` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `output_contract_version` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `config_json` json NOT NULL,
  `created_by_user_id` int NOT NULL,
  `legacy_source_table` varchar(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `legacy_id` varchar(191) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_strategy_versions_identity` (`id`,`strategy_id`),
  UNIQUE KEY `uk_strategy_versions_number` (`strategy_id`,`version_number`),
  UNIQUE KEY `uk_strategy_versions_legacy` (`legacy_source_table`,`legacy_id`),
  KEY `idx_strategy_versions_created` (`strategy_id`,`created_at_utc`,`id`),
  KEY `fk_strategy_versions_creator` (`created_by_user_id`),
  CONSTRAINT `fk_strategy_versions_creator` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_strategy_versions_strategy` FOREIGN KEY (`strategy_id`) REFERENCES `strategies` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `strategies` ADD CONSTRAINT `fk_strategies_active_version` FOREIGN KEY (`active_version_id`, `id`) REFERENCES `strategy_versions` (`id`, `strategy_id`);
