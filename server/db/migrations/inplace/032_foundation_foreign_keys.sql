ALTER TABLE `bridge_refresh_sessions` ADD CONSTRAINT `fk_v4_bridge_refresh_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);

ALTER TABLE `user_model_defaults` ADD CONSTRAINT `fk_v4_model_default_profile` FOREIGN KEY (`model_profile_id`) REFERENCES `ai_model_profiles` (`id`);

ALTER TABLE `ai_model_provider_capabilities` ADD CONSTRAINT `fk_v4_capabilities_profile` FOREIGN KEY (`model_profile_id`) REFERENCES `ai_model_profiles` (`id`);

ALTER TABLE `ai_model_provider_capabilities` ADD CONSTRAINT `fk_v4_capabilities_verifier` FOREIGN KEY (`verified_by_user_id`) REFERENCES `users` (`id`);

ALTER TABLE `ai_model_usage_logs` ADD CONSTRAINT `fk_v4_model_usage_profile` FOREIGN KEY (`model_profile_id`) REFERENCES `ai_model_profiles` (`id`);
