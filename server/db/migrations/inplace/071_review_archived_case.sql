-- Historical records are readable but never scheduled as new work.
ALTER TABLE review_cases_v4
  MODIFY COLUMN status ENUM('awaiting_evidence','queued','running','awaiting_confirmation','needs_changes','confirmed','failed','archived') NOT NULL;

CREATE TABLE review_case_history_v4 (
  review_case_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_evidence_status VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_strategy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_strategy_version VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  archive_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_stream_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_bundle_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  timezone_source ENUM('legacy_evidence','legacy_case','default_utc_plus_3') NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (review_case_id),
  UNIQUE KEY uk_review_history_source (source_table,source_id),
  CONSTRAINT fk_review_history_case FOREIGN KEY (review_case_id) REFERENCES review_cases_v4 (id),
  CONSTRAINT fk_review_history_archive FOREIGN KEY (archive_run_id,archive_stream_id) REFERENCES data_migration_checkpoints (run_id,stream_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE review_versions_v4
  MODIFY COLUMN trade_count INT UNSIGNED NULL DEFAULT 0;
