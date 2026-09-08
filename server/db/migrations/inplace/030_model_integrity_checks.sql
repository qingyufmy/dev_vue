ALTER TABLE `ai_model_profiles` ADD CONSTRAINT `chk_v4_model_profiles_owner` CHECK ((scope='platform' AND owner_user_id=0) OR (scope='user' AND owner_user_id>0));

ALTER TABLE `platform_model_usage_policy` ADD CONSTRAINT `chk_v4_model_policy_singleton` CHECK (id=1);
