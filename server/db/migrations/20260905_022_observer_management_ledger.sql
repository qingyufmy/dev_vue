-- P4B management coordination and idempotent operation receipts only.
-- No observer sources, channels or grants are seeded by this migration.
CREATE TABLE observer_management_registry (
  id TINYINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT chk_observer_management_registry_singleton CHECK (id=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO observer_management_registry (id,revision) VALUES (1,0);

CREATE TABLE observer_management_operations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id INT NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json JSON NOT NULL,
  audit_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_observer_management_operations_actor_key (actor_user_id,idempotency_key),
  KEY idx_observer_management_operations_created (created_at_utc,id),
  CONSTRAINT fk_observer_management_operations_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
