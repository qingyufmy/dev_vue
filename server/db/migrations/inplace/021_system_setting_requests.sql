CREATE TABLE system_setting_requests (
  actor_user_id INT NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  setting_id INT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  recorded_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (actor_user_id, request_id),
  UNIQUE KEY uk_system_setting_receipt_change (setting_id, revision),
  CONSTRAINT fk_system_setting_receipt_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT fk_system_setting_receipt_change FOREIGN KEY (setting_id, revision) REFERENCES system_setting_changes(setting_id, revision),
  CONSTRAINT chk_system_setting_receipt_revision CHECK (revision > 1),
  CONSTRAINT chk_system_setting_receipt_request CHECK (
    REGEXP_LIKE(request_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')
    AND NOT REGEXP_LIKE(request_id, '[^0-9a-f-]', 'c')),
  CONSTRAINT chk_system_setting_receipt_hash CHECK (
    REGEXP_LIKE(request_sha256, '^[0-9a-f]{64}$', 'c')
    AND NOT REGEXP_LIKE(request_sha256, '[^0-9a-f]', 'c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
