-- Preserve historical UTC values and nullability; extend precision only.

ALTER TABLE `users` MODIFY COLUMN `plan_expires_at` datetime(3) DEFAULT NULL;

ALTER TABLE `users` MODIFY COLUMN `deleted_at` datetime(3) DEFAULT NULL;

ALTER TABLE `users` MODIFY COLUMN `created_at` datetime(3) DEFAULT (now(3));

ALTER TABLE `users` MODIFY COLUMN `updated_at` datetime(3) DEFAULT (now(3));

ALTER TABLE `bridge_refresh_sessions` MODIFY COLUMN `expires_at` datetime(3) NOT NULL;

ALTER TABLE `bridge_refresh_sessions` MODIFY COLUMN `revoked_at` datetime(3) DEFAULT NULL;

ALTER TABLE `bridge_refresh_sessions` MODIFY COLUMN `last_used_at` datetime(3) DEFAULT NULL;

ALTER TABLE `bridge_refresh_sessions` MODIFY COLUMN `created_at` datetime(3) NOT NULL;

ALTER TABLE `bridge_refresh_sessions` MODIFY COLUMN `updated_at` datetime(3) NOT NULL;

ALTER TABLE `ai_model_profiles` MODIFY COLUMN `created_at` datetime(3) NOT NULL;

ALTER TABLE `ai_model_profiles` MODIFY COLUMN `updated_at` datetime(3) NOT NULL;

ALTER TABLE `ai_model_profiles` MODIFY COLUMN `deleted_at` datetime(3) DEFAULT NULL;

ALTER TABLE `user_model_defaults` MODIFY COLUMN `created_at` datetime(3) NOT NULL;

ALTER TABLE `user_model_defaults` MODIFY COLUMN `updated_at` datetime(3) NOT NULL;

ALTER TABLE `platform_model_usage_policy` MODIFY COLUMN `updated_at` datetime(3) NOT NULL;

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `created_at` datetime(3) NOT NULL;
