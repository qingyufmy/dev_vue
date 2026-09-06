-- Offline migration tooling only. No jobs, policies, business rows or active grants are seeded.
CREATE TABLE data_migration_runs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bindings_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bindings_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE data_migration_checkpoints (
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stream_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence_number BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cursor_json JSON NULL,
  processed_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (run_id, stream_id),
  CONSTRAINT fk_data_checkpoint_run FOREIGN KEY (run_id) REFERENCES data_migration_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE data_migration_batches (
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stream_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence_number BIGINT UNSIGNED NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  row_count INT UNSIGNED NOT NULL,
  end_cursor_json JSON NOT NULL,
  recorded_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (run_id, batch_id),
  UNIQUE KEY uk_data_batch_sequence (run_id, stream_id, sequence_number),
  CONSTRAINT fk_data_batch_run FOREIGN KEY (run_id) REFERENCES data_migration_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE data_migration_id_maps (
  logical_source_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_pk_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_pk_json JSON NOT NULL,
  target_json JSON NOT NULL,
  created_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (logical_source_id, entity_kind, source_table, source_pk_sha256),
  CONSTRAINT fk_data_id_map_run FOREIGN KEY (created_run_id) REFERENCES data_migration_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE data_migration_row_receipts (
  run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stream_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_pk_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_pk_json JSON NOT NULL,
  source_bytes_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transformed_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  targets_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (run_id, stream_id, source_pk_sha256),
  CONSTRAINT fk_data_receipt_batch FOREIGN KEY (run_id, batch_id) REFERENCES data_migration_batches (run_id, batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
