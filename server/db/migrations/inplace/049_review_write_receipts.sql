-- Append-only review write receipts; preserves all existing review/history rows.
-- Apply through a verified upgrade coordinator, never on application startup.
CREATE TABLE review_write_receipts_v4 (
  actor_user_id INT NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_revision BIGINT UNSIGNED NOT NULL,
  result_json JSON NOT NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recorded_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (actor_user_id,idempotency_key),
  KEY idx_review_receipt_actor_time (actor_user_id,recorded_at_utc,idempotency_key),
  CONSTRAINT fk_review_receipt_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT chk_review_receipt_action CHECK (action IN (
    'create_manual_case','request_generation','create_version',
    'confirm_version','return_case','decide_memory_update')),
  CONSTRAINT chk_review_receipt_revision CHECK (result_revision > 0 AND result_revision <= 9007199254740991),
  CONSTRAINT chk_review_receipt_result CHECK (JSON_TYPE(result_json) = 'OBJECT'),
  CONSTRAINT chk_review_receipt_key CHECK (CHAR_LENGTH(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT chk_review_receipt_hashes CHECK (
    REGEXP_LIKE(request_sha256,'^[0-9a-f]{64}$','c') AND NOT REGEXP_LIKE(request_sha256,'[^0-9a-f]','c')
    AND REGEXP_LIKE(result_sha256,'^[0-9a-f]{64}$','c') AND NOT REGEXP_LIKE(result_sha256,'[^0-9a-f]','c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
