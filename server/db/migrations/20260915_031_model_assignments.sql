CREATE TABLE user_model_assignments_v4 (
 user_id INT NOT NULL PRIMARY KEY,
 analysis_model_profile_id INT NULL,
 trader_model_profile_id INT NULL,
 review_model_profile_id INT NULL,
 revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
 updated_at_utc DATETIME(3) NOT NULL,
 CONSTRAINT fk_model_assignment_analysis FOREIGN KEY (analysis_model_profile_id) REFERENCES ai_model_profiles(id),
 CONSTRAINT fk_model_assignment_trader FOREIGN KEY (trader_model_profile_id) REFERENCES ai_model_profiles(id),
 CONSTRAINT fk_model_assignment_review FOREIGN KEY (review_model_profile_id) REFERENCES ai_model_profiles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
