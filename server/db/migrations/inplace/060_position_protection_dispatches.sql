-- Candidate only. Requires 059 and the complete Bridge command parent schema.
CREATE TABLE position_protection_dispatches_v4 (
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_revision INT UNSIGNED NOT NULL,
  review_json JSON NOT NULL,
  review_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checked_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (bridge_command_id),
  CONSTRAINT ck_protection_dispatch_revision CHECK (command_revision=2),
  CONSTRAINT fk_protection_dispatch_binding FOREIGN KEY (bridge_command_id)
    REFERENCES position_protection_commands_v4 (bridge_command_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
