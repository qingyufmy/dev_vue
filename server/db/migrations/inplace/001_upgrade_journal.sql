-- Dedicated same-database upgrade history; legacy schema_migrations is untouched.
CREATE TABLE database_upgrade_steps_v4 (
  id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('started','completed') NOT NULL,
  started_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
