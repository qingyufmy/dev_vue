ALTER TABLE referral_rules
  ADD COLUMN revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_referral_rule_rate CHECK (rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT chk_referral_rule_enabled CHECK (enabled IN (0, 1)),
  ADD CONSTRAINT chk_referral_rule_revision CHECK (revision > 0);
