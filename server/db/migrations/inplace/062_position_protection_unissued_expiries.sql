-- Candidate only. Absence of a command is distinct from a terminal execution outcome.
CREATE TABLE position_protection_unissued_expiries_v4 (
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  child_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_json JSON NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (workflow_id),
  UNIQUE KEY uk_protection_unissued_child (child_intent_id),
  CONSTRAINT fk_protection_unissued_child FOREIGN KEY (child_intent_id,workflow_id) REFERENCES execution_intents (id,position_workflow_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
