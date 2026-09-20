-- Additive only: legacy decisions and event-less strategies remain unchanged.
CREATE TABLE inference_entry_event_claims_v4 (
  decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  event_id CHAR(70) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  active_event_id CHAR(70) CHARACTER SET ascii COLLATE ascii_bin NULL,
  state ENUM('reserved','consumed','released') NOT NULL,
  risk_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (decision_id,action_id),
  UNIQUE KEY uk_entry_event_active (user_id,trading_account_id,strategy_id,active_event_id),
  KEY idx_entry_event_history (user_id,trading_account_id,strategy_id,event_id,created_at_utc),
  CONSTRAINT fk_entry_event_decision FOREIGN KEY (decision_id) REFERENCES trade_decisions(id),
  CONSTRAINT fk_entry_event_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id),
  CONSTRAINT fk_entry_event_strategy FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  CONSTRAINT fk_entry_event_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_entry_event_risk FOREIGN KEY (risk_decision_id) REFERENCES risk_decisions_v4(id),
  CONSTRAINT chk_entry_event_active CHECK ((state='released' AND active_event_id IS NULL) OR (state IN ('reserved','consumed') AND active_event_id IS NOT NULL AND active_event_id=event_id)),
  CONSTRAINT chk_entry_event_risk CHECK ((state='reserved' AND risk_decision_id IS NULL) OR (state IN ('consumed','released') AND risk_decision_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
