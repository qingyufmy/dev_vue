-- Candidate only: atomic command/authority binding. Requires complete Bridge parents and 056/058.
ALTER TABLE bridge_commands_v4
  ADD UNIQUE KEY uk_bridge_command_intent_pair (id,execution_intent_id);

CREATE TABLE position_protection_commands_v4 (
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  child_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  binding_json JSON NOT NULL,
  binding_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  authority_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (bridge_command_id),
  UNIQUE KEY uk_protection_command_child (child_intent_id),
  UNIQUE KEY uk_protection_command_workflow (workflow_id),
  CONSTRAINT fk_protection_command_child FOREIGN KEY (child_intent_id,workflow_id) REFERENCES execution_intents (id,position_workflow_id),
  CONSTRAINT fk_protection_command_bridge FOREIGN KEY (bridge_command_id,child_intent_id) REFERENCES bridge_commands_v4 (id,execution_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
