ALTER TABLE `bridge_refresh_sessions` ADD UNIQUE KEY `uk_bridge_refresh_migration_key` (`migration_key`);

ALTER TABLE `bridge_refresh_sessions` ADD UNIQUE KEY `uk_bridge_refresh_source_migration` (`source_refresh_session_id`);

ALTER TABLE `bridge_refresh_sessions` ADD KEY `idx_bridge_refresh_device` (`user_id`,`installation_id`,`profile_id`,`credential_version`,`revoked_at`,`expires_at`);

ALTER TABLE `ai_model_profiles` ADD KEY `idx_v4_model_profiles_owner` (`owner_user_id`,`scope`,`status`,`deleted_at`,`id`);

ALTER TABLE `ai_model_usage_logs` ADD KEY `idx_v4_model_usage_quota` (`user_id`,`credential_source`,`created_at`,`request_phase`);

ALTER TABLE `ai_model_usage_logs` ADD KEY `idx_v4_model_usage_recovery` (`request_status`,`created_at`,`id`);
