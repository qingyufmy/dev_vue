CREATE TABLE `user_referral_accounts` (
  `user_id` int NOT NULL,
  `referral_code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `referred_by_code` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `referral_credit` decimal(20,8) NOT NULL,
  `revision` bigint unsigned NOT NULL DEFAULT '1',
  `updated_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`user_id`),
  KEY `idx_user_referral_accounts_referral_code` (`referral_code`),
  CONSTRAINT `fk_user_referral_accounts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
