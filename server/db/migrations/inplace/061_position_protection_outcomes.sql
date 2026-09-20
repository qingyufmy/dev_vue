-- Candidate only. Retains the exact evidence used to finish a protection workflow.
CREATE TABLE position_protection_outcomes_v4 (
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  child_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_json JSON NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (workflow_id),
  UNIQUE KEY uk_protection_outcome_command (bridge_command_id),
  CONSTRAINT ck_protection_outcome_status CHECK (status IN ('succeeded','stopped')),
  CONSTRAINT fk_protection_outcome_child FOREIGN KEY (child_intent_id,workflow_id) REFERENCES execution_intents (id,position_workflow_id),
  CONSTRAINT fk_protection_outcome_command FOREIGN KEY (bridge_command_id,child_intent_id) REFERENCES bridge_commands_v4 (id,execution_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
