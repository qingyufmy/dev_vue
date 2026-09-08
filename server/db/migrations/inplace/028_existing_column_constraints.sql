-- Preserve all stored facts and IDs; unknown margin mode has no fabricated default.

ALTER TABLE `ai_model_usage_logs` MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT;

ALTER TABLE `trading_accounts` MODIFY COLUMN `broker_server` varchar(191) NOT NULL DEFAULT '';

ALTER TABLE `users` MODIFY COLUMN `nickname` varchar(100) NOT NULL DEFAULT '';

ALTER TABLE `users` MODIFY COLUMN `avatar` varchar(500) NOT NULL DEFAULT '';

ALTER TABLE `users` MODIFY COLUMN `role` varchar(20) NOT NULL DEFAULT 'user';

ALTER TABLE `users` MODIFY COLUMN `plan` varchar(20) NOT NULL DEFAULT 'free';

ALTER TABLE `users` MODIFY COLUMN `created_at` datetime(3) NOT NULL DEFAULT (now(3));

ALTER TABLE `users` MODIFY COLUMN `updated_at` datetime(3) NOT NULL DEFAULT (now(3));

ALTER TABLE `trading_accounts` MODIFY COLUMN `margin_mode` varchar(20) DEFAULT NULL;
