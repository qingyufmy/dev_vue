-- Candidate DDL; register in the upgrade plan only after reference validation.
CREATE TABLE IF NOT EXISTS manual_review_candidate_evidence_v4 (
  candidate_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_revision BIGINT UNSIGNED NOT NULL,
  trade_record_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trade_record_revision BIGINT UNSIGNED NOT NULL,
  as_of_utc DATETIME(3) NOT NULL,
  evidence_json JSON NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_bytes INT UNSIGNED NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (candidate_id,candidate_revision),
  CONSTRAINT fk_manual_candidate_evidence_candidate FOREIGN KEY (candidate_id) REFERENCES manual_review_candidates_v4 (id),
  CONSTRAINT chk_manual_candidate_evidence_revision CHECK (candidate_revision > 0 AND trade_record_revision > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
