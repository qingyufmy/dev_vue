-- CHAR(36) silently clips trailing whitespace before CHECK evaluation.
-- Retain that input so the existing strict UUID checks can reject it.
ALTER TABLE learning_progress_changes
  MODIFY request_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
