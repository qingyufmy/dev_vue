ALTER TABLE execution_intents
  DROP FOREIGN KEY fk_execution_intent_risk,
  DROP FOREIGN KEY fk_execution_intent_trade,
  DROP INDEX uk_execution_intent_action,
  MODIFY COLUMN risk_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY COLUMN trade_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY COLUMN risk_decision_revision BIGINT UNSIGNED NULL,
  ADD COLUMN user_command_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER trade_decision_id,
  ADD UNIQUE KEY uk_execution_intent_source_action (source_type, source_id, action_id),
  ADD CONSTRAINT fk_execution_intent_risk_v4 FOREIGN KEY (risk_decision_id) REFERENCES risk_decisions_v4 (id),
  ADD CONSTRAINT fk_execution_intent_trade_v4 FOREIGN KEY (trade_decision_id) REFERENCES trade_decisions (id),
  ADD CONSTRAINT fk_execution_intent_user_command FOREIGN KEY (user_command_id) REFERENCES user_execution_commands (id),
  ADD CONSTRAINT chk_execution_intent_source_family CHECK (
    (source_type='risk_decision' AND risk_decision_id IS NOT NULL AND trade_decision_id IS NOT NULL AND user_command_id IS NULL) OR
    (source_type<>'risk_decision' AND risk_decision_id IS NULL AND trade_decision_id IS NULL AND user_command_id IS NOT NULL)
  );
