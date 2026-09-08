-- Preserve values, NULL, defaults and collations; no primary or foreign key changes.

ALTER TABLE `ai_model_profiles` MODIFY COLUMN `provider` varchar(64) NOT NULL DEFAULT 'deepseek';

ALTER TABLE `ai_model_profiles` MODIFY COLUMN `model_name` varchar(191) NOT NULL DEFAULT 'deepseek-chat';

ALTER TABLE `ai_model_profiles` MODIFY COLUMN `max_tokens` int unsigned DEFAULT '2000';

ALTER TABLE `ai_model_profiles` MODIFY COLUMN `request_timeout_ms` int unsigned DEFAULT NULL;

ALTER TABLE `platform_model_usage_policy` MODIFY COLUMN `daily_requests_per_user` int unsigned NOT NULL DEFAULT '100';

ALTER TABLE `platform_model_usage_policy` MODIFY COLUMN `daily_tokens_per_user` bigint unsigned NOT NULL DEFAULT '500000';

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `token_count` bigint unsigned NOT NULL DEFAULT '0';

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `request_bytes` bigint unsigned NOT NULL DEFAULT '0';

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `response_bytes` bigint unsigned NOT NULL DEFAULT '0';

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `duration_ms` bigint unsigned NOT NULL DEFAULT '0';

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `input_tokens` bigint unsigned NOT NULL DEFAULT '0';

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `output_tokens` bigint unsigned NOT NULL DEFAULT '0';

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `reasoning_tokens` bigint unsigned NOT NULL DEFAULT '0';

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `cached_tokens` bigint unsigned NOT NULL DEFAULT '0';
