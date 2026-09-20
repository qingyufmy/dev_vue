-- Append after the current 077 registry. Historical 050 was not applied to current dev_vue.
-- Do not modify or insert into previously completed migration journal entries.
-- Existing V4 memory and inference parents must be admitted before this step.
-- Keep legacy records and their token_count values unchanged; unknown new usage is NULL.
ALTER TABLE strategy_memory_injection_logs_v4
  MODIFY COLUMN runtime_kind ENUM('analysis','trader','review','memory_compression') NOT NULL,
  MODIFY COLUMN token_count INT UNSIGNED NULL,
  ADD COLUMN record_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN input_snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN input_snapshot_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN estimated_token_count INT UNSIGNED NULL,
  ADD COLUMN token_estimate_method VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD KEY idx_memory_injection_snapshot (input_snapshot_id,id),
  ADD CONSTRAINT fk_memory_injection_input_snapshot FOREIGN KEY (input_snapshot_id) REFERENCES inference_snapshots (id),
  ADD CONSTRAINT chk_memory_injection_record_version CHECK (record_version IN (1,2)),
  ADD CONSTRAINT chk_memory_injection_v2_source CHECK (record_version=1 OR (
    input_snapshot_id IS NOT NULL AND input_snapshot_sha256 IS NOT NULL
    AND REGEXP_LIKE(input_snapshot_sha256,'^[0-9a-f]{64}$','c')
    AND estimated_token_count IS NOT NULL AND token_estimate_method IS NOT NULL
    AND token_estimate_method='utf8_bytes_div4_v1'
  ));
