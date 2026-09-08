ALTER TABLE `strategy_subscriptions` ADD CONSTRAINT `fk_strategy_subscriptions_account` FOREIGN KEY (`trading_account_id`) REFERENCES `trading_accounts` (`id`);

ALTER TABLE `strategy_subscriptions` ADD CONSTRAINT `fk_strategy_subscriptions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);
