-- Change defaults for future INSERTs only. Preserve existing user values.
ALTER TABLE `users` ALTER COLUMN `email_verified` SET DEFAULT NULL;
ALTER TABLE `users` ALTER COLUMN `phone_verified` SET DEFAULT NULL;
ALTER TABLE `users` ALTER COLUMN `auth_method` SET DEFAULT NULL;
ALTER TABLE `users` ALTER COLUMN `plan_period` SET DEFAULT NULL;
ALTER TABLE `users` ALTER COLUMN `changelog_seen_version` SET DEFAULT NULL;
