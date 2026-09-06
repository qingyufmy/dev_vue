CREATE TABLE `data_migration_source_rows` (
  `run_id` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stream_id` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_pk_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_bytes_sha256` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_payload_json` json NOT NULL,
  `created_at_utc` datetime(3) NOT NULL,
  PRIMARY KEY (`run_id`,`stream_id`,`source_pk_sha256`),
  CONSTRAINT `fk_data_source_row_receipt` FOREIGN KEY (`run_id`, `stream_id`, `source_pk_sha256`) REFERENCES `data_migration_row_receipts` (`run_id`, `stream_id`, `source_pk_sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
