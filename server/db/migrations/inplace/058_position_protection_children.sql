-- Candidate only. Requires 056 and the complete execution parent schema; not a runtime activation.
ALTER TABLE execution_intents
  DROP CHECK chk_execution_intent_source_family,
  ADD COLUMN position_workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uk_execution_intent_position_workflow (position_workflow_id),
  ADD UNIQUE KEY uk_execution_intent_workflow_pair (id,position_workflow_id),
  ADD CONSTRAINT fk_execution_intent_position_workflow FOREIGN KEY (position_workflow_id) REFERENCES partial_close_workflows_v4 (id),
  ADD CONSTRAINT chk_execution_intent_source_family CHECK (
    (source_type='risk_decision' AND risk_decision_id IS NOT NULL AND trade_decision_id IS NOT NULL AND user_command_id IS NULL AND position_workflow_id IS NULL) OR
    (source_type NOT IN ('risk_decision','position_workflow') AND risk_decision_id IS NULL AND trade_decision_id IS NULL AND user_command_id IS NOT NULL AND position_workflow_id IS NULL) OR
    (source_type='position_workflow' AND risk_decision_id IS NULL AND trade_decision_id IS NULL AND user_command_id IS NULL
      AND risk_decision_revision IS NULL AND position_workflow_id IS NOT NULL AND source_id=position_workflow_id AND action_kind='modify_position')
  );

CREATE TABLE position_protection_reviews_v4 (
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workflow_revision BIGINT UNSIGNED NOT NULL,
  request_json JSON NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  review_json JSON NOT NULL,
  review_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('approved','rejected') NOT NULL,
  child_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  child_json JSON NULL,
  child_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (workflow_id),
  UNIQUE KEY uk_protection_review_child (child_intent_id),
  CONSTRAINT fk_protection_review_workflow FOREIGN KEY (workflow_id) REFERENCES partial_close_workflows_v4 (id),
  CONSTRAINT fk_protection_review_child FOREIGN KEY (child_intent_id,workflow_id) REFERENCES execution_intents (id,position_workflow_id),
  CONSTRAINT chk_protection_review_revision CHECK (workflow_revision=2),
  CONSTRAINT chk_protection_review_child CHECK (
    (status='approved' AND child_intent_id IS NOT NULL AND child_json IS NOT NULL AND child_sha256 IS NOT NULL) OR
    (status='rejected' AND child_intent_id IS NULL AND child_json IS NULL AND child_sha256 IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
