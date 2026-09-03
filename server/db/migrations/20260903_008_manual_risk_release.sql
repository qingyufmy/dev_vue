-- Stage 12D.1: audited account risk manual release.
-- TARGET: V4 side-by-side database after 20260903_007. Existing policy, state and decision rows are preserved.
-- A release acknowledges one current account-level breach episode. It never disables platform, data-integrity,
-- ownership, permission, quote, contract, stop-loss or terminal safeguards.

CREATE TABLE IF NOT EXISTS risk_manual_releases (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  platform_policy_version_id BIGINT UNSIGNED NOT NULL,
  account_policy_version_id BIGINT UNSIGNED NULL,
  policy_set_revision BIGINT UNSIGNED NOT NULL,
  risk_state_revision BIGINT UNSIGNED NOT NULL,
  released_rules_json JSON NOT NULL,
  baseline_json JSON NOT NULL,
  breach_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason VARCHAR(500) NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('active','superseded','expired','revoked') NOT NULL DEFAULT 'active',
  expires_at_utc DATETIME(3) NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  invalidated_at_utc DATETIME(3) NULL,
  invalidation_reason VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_risk_manual_release_request (user_id, trading_account_id, idempotency_key),
  UNIQUE KEY uk_risk_manual_release_episode (trading_account_id, breach_fingerprint),
  UNIQUE KEY uk_risk_manual_release_legacy (legacy_source_table, legacy_id),
  KEY idx_risk_manual_release_active (trading_account_id, status, expires_at_utc, created_at_utc),
  CONSTRAINT fk_risk_manual_release_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_risk_manual_release_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_risk_manual_release_platform_policy FOREIGN KEY (platform_policy_version_id) REFERENCES risk_policy_versions (id),
  CONSTRAINT fk_risk_manual_release_account_policy FOREIGN KEY (account_policy_version_id) REFERENCES risk_policy_versions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE risk_decisions
  ADD COLUMN manual_release_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER account_risk_revision,
  ADD KEY idx_risk_decision_manual_release (manual_release_id),
  ADD CONSTRAINT fk_risk_decision_manual_release FOREIGN KEY (manual_release_id) REFERENCES risk_manual_releases (id);

SET @risk_manual_platform_set_id := (
  SELECT id FROM risk_policy_sets WHERE scope='platform' AND status='active' ORDER BY id LIMIT 1
);
SET @risk_manual_policy_json := (
  SELECT IF(
    JSON_TYPE(JSON_EXTRACT(v.policy_json,'$.values'))='OBJECT',
    JSON_SET(
      v.policy_json,
      '$.values.manualReleaseEnabled', TRUE,
      '$.values.manualReleaseMaxDailyLossPercent', 5,
      '$.values.manualReleaseMaxDrawdownPercent', 12,
      '$.values.manualReleaseMaxDailyOpenCount', 30,
      '$.values.manualReleaseConsecutiveLossLimit', 5
    ),
    JSON_SET(
      v.policy_json,
      '$.manualReleaseEnabled', TRUE,
      '$.manualReleaseMaxDailyLossPercent', 5,
      '$.manualReleaseMaxDrawdownPercent', 12,
      '$.manualReleaseMaxDailyOpenCount', 30,
      '$.manualReleaseConsecutiveLossLimit', 5
    )
  )
  FROM risk_policy_sets p
  INNER JOIN risk_policy_versions v ON v.id=p.active_version_id AND v.policy_set_id=p.id
  WHERE p.id=@risk_manual_platform_set_id
  LIMIT 1
);
SET @risk_manual_version_number := (
  SELECT COALESCE(MAX(version_number),0)+1 FROM risk_policy_versions WHERE policy_set_id=@risk_manual_platform_set_id
);

INSERT INTO risk_policy_versions (
  policy_set_id,version_number,policy_json,policy_sha256,created_by_user_id,change_reason,created_at_utc
)
SELECT
  @risk_manual_platform_set_id,@risk_manual_version_number,@risk_manual_policy_json,
  SHA2(CAST(@risk_manual_policy_json AS CHAR),256),NULL,'Stage 12D.1 manual release platform boundaries',UTC_TIMESTAMP(3)
FROM risk_policy_sets p
INNER JOIN risk_policy_versions v ON v.id=p.active_version_id AND v.policy_set_id=p.id
WHERE p.id=@risk_manual_platform_set_id
  AND COALESCE(
    JSON_EXTRACT(v.policy_json,'$.manualReleaseEnabled'),
    JSON_EXTRACT(v.policy_json,'$.values.manualReleaseEnabled')
  ) IS NULL;

SET @risk_manual_version_id := IF(ROW_COUNT()=1,LAST_INSERT_ID(),NULL);

UPDATE risk_policy_sets
SET active_version_id=@risk_manual_version_id,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3)
WHERE id=@risk_manual_platform_set_id AND @risk_manual_version_id IS NOT NULL;

-- Legacy account unlocks or risk resets are not silently imported. A bounded migration job must classify each
-- source row, preserve its original actor/time/reason, and reject rows without an exact account and breach episode.
