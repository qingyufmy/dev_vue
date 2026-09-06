CREATE TABLE referral_rule_changes (
  rule_id INT NOT NULL,
  rule_revision BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id INT NOT NULL,
  previous_rate_bps INT NOT NULL,
  rate_bps INT NOT NULL,
  previous_enabled TINYINT NOT NULL,
  enabled TINYINT NOT NULL,
  recorded_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (rule_id, rule_revision),
  UNIQUE KEY uk_referral_rule_request (request_id, rule_id),
  CONSTRAINT fk_referral_rule_change_rule FOREIGN KEY (rule_id) REFERENCES referral_rules(id),
  CONSTRAINT fk_referral_rule_change_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT chk_referral_rule_change_revision CHECK (rule_revision > 1),
  CONSTRAINT chk_referral_rule_change_rates CHECK (previous_rate_bps BETWEEN 0 AND 10000 AND rate_bps BETWEEN 0 AND 10000),
  CONSTRAINT chk_referral_rule_change_enabled CHECK (previous_enabled IN (0, 1) AND enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
