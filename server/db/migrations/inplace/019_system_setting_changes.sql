CREATE TABLE system_setting_changes (
  setting_id INT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id INT NOT NULL,
  previous_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  current_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recorded_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (setting_id, revision),
  UNIQUE KEY uk_system_setting_request (request_id, setting_id),
  CONSTRAINT fk_system_setting_change_setting FOREIGN KEY (setting_id) REFERENCES system_settings(id),
  CONSTRAINT fk_system_setting_change_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT chk_system_setting_change_revision CHECK (revision > 1),
  CONSTRAINT chk_system_setting_change_request CHECK (REGEXP_LIKE(request_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')),
  CONSTRAINT chk_system_setting_change_hash CHECK (REGEXP_LIKE(previous_sha256, '^[0-9a-f]{64}$', 'c') AND REGEXP_LIKE(current_sha256, '^[0-9a-f]{64}$', 'c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
