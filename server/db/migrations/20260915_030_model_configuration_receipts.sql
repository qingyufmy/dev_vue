CREATE TABLE model_configuration_receipts_v4 (
  actor_user_id INT NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  model_profile_id INT NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  result_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (actor_user_id, request_id),
  KEY idx_model_configuration_audit (model_profile_id, created_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
