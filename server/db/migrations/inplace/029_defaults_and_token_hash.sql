-- Future defaults and exact token hash comparison only; existing facts remain unchanged.

ALTER TABLE `ai_model_profiles` ALTER COLUMN `owner_user_id` DROP DEFAULT;

ALTER TABLE `ai_model_profiles` ALTER COLUMN `scope` DROP DEFAULT;

ALTER TABLE `ai_model_profiles` ALTER COLUMN `provider` DROP DEFAULT;

ALTER TABLE `ai_model_profiles` ALTER COLUMN `model_name` DROP DEFAULT;

ALTER TABLE `ai_model_profiles` ALTER COLUMN `temperature` SET DEFAULT NULL;

ALTER TABLE `ai_model_profiles` ALTER COLUMN `max_tokens` SET DEFAULT NULL;

ALTER TABLE `ai_model_profiles` ALTER COLUMN `thinking_enabled` SET DEFAULT '0';

ALTER TABLE `ai_model_profiles` ALTER COLUMN `reasoning_effort` SET DEFAULT NULL;

ALTER TABLE `ai_model_profiles` ALTER COLUMN `status` SET DEFAULT 'inactive';

ALTER TABLE `platform_model_usage_policy` ALTER COLUMN `id` DROP DEFAULT;

ALTER TABLE `platform_model_usage_policy` ALTER COLUMN `daily_requests_per_user` SET DEFAULT '0';

ALTER TABLE `platform_model_usage_policy` ALTER COLUMN `daily_tokens_per_user` SET DEFAULT '0';

ALTER TABLE `ai_model_usage_logs` ALTER COLUMN `credential_source` DROP DEFAULT;

ALTER TABLE `ai_model_usage_logs` ALTER COLUMN `request_phase` DROP DEFAULT;

ALTER TABLE `ai_model_usage_logs` ALTER COLUMN `request_status` DROP DEFAULT;

ALTER TABLE `ai_model_usage_logs` ALTER COLUMN `accounting_status` SET DEFAULT 'usage_unknown';

ALTER TABLE `bridge_refresh_sessions` MODIFY COLUMN `token_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
