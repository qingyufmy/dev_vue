-- Stage 12R: normalized V4 review cases, immutable versions and strategy memory.
-- TARGET: V4 side-by-side database after 20260904_011. Never run against the
-- legacy source database. This migration is append-only: legacy review and
-- memory rows are migrated later through bounded checkpoints and source maps.

CREATE TABLE IF NOT EXISTS review_cases_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('daily','monthly','manual') NOT NULL,
  scope_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  standard_symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  subscription_id BIGINT UNSIGNED NULL,
  subscription_revision BIGINT UNSIGNED NULL,
  analysis_strategy_id BIGINT UNSIGNED NULL,
  analysis_strategy_version_id BIGINT UNSIGNED NULL,
  trader_strategy_id BIGINT UNSIGNED NULL,
  trader_strategy_version_id BIGINT UNSIGNED NULL,
  terminal_period_start_utc DATETIME(3) NOT NULL,
  terminal_period_end_utc DATETIME(3) NOT NULL,
  terminal_timezone_offset_minutes SMALLINT NOT NULL,
  status ENUM('awaiting_evidence','queued','running','awaiting_confirmation','needs_changes','confirmed','failed') NOT NULL,
  evidence_status ENUM('pending','incomplete','complete','stale') NOT NULL,
  evidence_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  current_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  confirmed_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  review_eligible_at_utc DATETIME(3) NULL,
  confirmed_by_user_id INT NULL,
  confirmed_at_utc DATETIME(3) NULL,
  return_reason VARCHAR(1000) NULL,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_case_scope (user_id, kind, scope_key),
  UNIQUE KEY uk_review_case_legacy (legacy_source_table, legacy_id),
  KEY idx_review_case_list (user_id, kind, updated_at_utc DESC, id),
  KEY idx_review_case_account (user_id, trading_account_id, terminal_period_end_utc DESC, id),
  KEY idx_review_case_generation (status, review_eligible_at_utc, updated_at_utc, id),
  CONSTRAINT fk_review_case_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_review_case_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_review_case_subscription FOREIGN KEY (subscription_id) REFERENCES strategy_subscriptions (id),
  CONSTRAINT fk_review_case_analysis_strategy FOREIGN KEY (analysis_strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_review_case_analysis_version FOREIGN KEY (analysis_strategy_version_id, analysis_strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT fk_review_case_trader_strategy FOREIGN KEY (trader_strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_review_case_trader_version FOREIGN KEY (trader_strategy_version_id, trader_strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT fk_review_case_confirmer FOREIGN KEY (confirmed_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_review_case_period CHECK (terminal_period_end_utc > terminal_period_start_utc),
  CONSTRAINT chk_review_case_strategy_pairs CHECK (
    (analysis_strategy_id IS NULL AND analysis_strategy_version_id IS NULL) OR
    (analysis_strategy_id IS NOT NULL AND analysis_strategy_version_id IS NOT NULL)
  ),
  CONSTRAINT chk_review_case_trader_pairs CHECK (
    (trader_strategy_id IS NULL AND trader_strategy_version_id IS NULL) OR
    (trader_strategy_id IS NOT NULL AND trader_strategy_version_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_case_sources_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  review_case_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_kind ENUM('market_analysis','trade_decision','risk_decision','execution_outcome','terminal_trade','period_review') NOT NULL,
  source_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_kind ENUM('direct','counterexample','missed_opportunity','false_positive') NOT NULL DEFAULT 'direct',
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_metadata_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_source_identity (review_case_id, source_kind, source_id, relation_kind),
  KEY idx_review_source_lookup (source_kind, source_id, review_case_id),
  CONSTRAINT fk_review_source_case FOREIGN KEY (review_case_id) REFERENCES review_cases_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_evidence_payloads_v4 (
  review_case_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_revision BIGINT UNSIGNED NOT NULL,
  evidence_json JSON NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_bytes BIGINT UNSIGNED NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (review_case_id, evidence_revision),
  CONSTRAINT fk_review_evidence_case FOREIGN KEY (review_case_id) REFERENCES review_cases_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_jobs_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  review_case_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  generation INT UNSIGNED NOT NULL,
  mode ENUM('initial','retry','refresh_evidence') NOT NULL,
  status ENUM('queued','preparing_evidence','waiting_model','validating','succeeded','retry_wait','failed','cancelled','completed_stale') NOT NULL,
  evidence_revision BIGINT UNSIGNED NOT NULL,
  input_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_profile_id INT NULL,
  progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
  current_stage VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at_utc DATETIME(3) NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at_utc DATETIME(3) NULL,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_job_generation (review_case_id, generation),
  KEY idx_review_job_claim (status, next_attempt_at_utc, lease_expires_at_utc, id),
  CONSTRAINT fk_review_job_case FOREIGN KEY (review_case_id) REFERENCES review_cases_v4 (id),
  CONSTRAINT fk_review_job_model_profile FOREIGN KEY (model_profile_id) REFERENCES ai_model_profiles (id),
  CONSTRAINT chk_review_job_progress CHECK (progress_percent <= 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_model_attempts_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  review_job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  model_profile_id INT NOT NULL,
  provider VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('running','succeeded','failed','timed_out','contract_invalid') NOT NULL,
  response_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  usage_json JSON NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  started_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_model_attempt_number (review_job_id, attempt_number),
  KEY idx_review_model_attempt_status (status, started_at_utc, id),
  CONSTRAINT fk_review_model_attempt_job FOREIGN KEY (review_job_id) REFERENCES review_jobs_v4 (id),
  CONSTRAINT fk_review_model_attempt_profile FOREIGN KEY (model_profile_id) REFERENCES ai_model_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_job_events_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  review_job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_status VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  to_status VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metadata_json JSON NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_review_job_event_stream (review_job_id, id),
  CONSTRAINT fk_review_job_event_job FOREIGN KEY (review_job_id) REFERENCES review_jobs_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_versions_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  review_case_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  source_job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  author_kind ENUM('ai','user') NOT NULL,
  created_by_user_id INT NULL,
  conclusion_code ENUM('effective','mixed','ineffective','insufficient_evidence','manual_trade_reviewed') NOT NULL,
  net_profit DECIMAL(24,8) NULL,
  trade_count INT UNSIGNED NOT NULL DEFAULT 0,
  win_rate_percent DECIMAL(7,4) NULL,
  profit_factor DECIMAL(18,8) NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_version_identity (id, review_case_id),
  UNIQUE KEY uk_review_version_number (review_case_id, version_number),
  KEY idx_review_version_job (source_job_id),
  CONSTRAINT fk_review_version_case FOREIGN KEY (review_case_id) REFERENCES review_cases_v4 (id),
  CONSTRAINT fk_review_version_job FOREIGN KEY (source_job_id) REFERENCES review_jobs_v4 (id),
  CONSTRAINT fk_review_version_actor FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_version_payloads_v4 (
  review_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_json JSON NOT NULL,
  full_analysis_text MEDIUMTEXT NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_bytes BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (review_version_id),
  CONSTRAINT fk_review_version_payload FOREIGN KEY (review_version_id) REFERENCES review_versions_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE review_cases_v4
  ADD CONSTRAINT fk_review_case_current_version FOREIGN KEY (current_version_id, id) REFERENCES review_versions_v4 (id, review_case_id),
  ADD CONSTRAINT fk_review_case_confirmed_version FOREIGN KEY (confirmed_version_id, id) REFERENCES review_versions_v4 (id, review_case_id);

CREATE TABLE IF NOT EXISTS review_user_states_v4 (
  review_case_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  seen_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  seen_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (review_case_id, user_id),
  KEY idx_review_user_unread (user_id, seen_at_utc, review_case_id),
  CONSTRAINT fk_review_user_state_case FOREIGN KEY (review_case_id) REFERENCES review_cases_v4 (id),
  CONSTRAINT fk_review_user_state_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_review_user_seen_version FOREIGN KEY (seen_version_id, review_case_id) REFERENCES review_versions_v4 (id, review_case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS manual_review_candidates_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  stable_trade_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  volume DECIMAL(24,8) NOT NULL,
  opened_at_utc DATETIME(3) NOT NULL,
  closed_at_utc DATETIME(3) NOT NULL,
  net_profit DECIMAL(24,8) NOT NULL,
  terminal_timezone_offset_minutes SMALLINT NOT NULL,
  source_classification ENUM('manual','system','other_ea','unknown') NOT NULL,
  eligibility_status ENUM('eligible','incomplete','already_reviewed') NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  selection_token_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  selection_expires_at_utc DATETIME(3) NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_manual_candidate_trade (user_id, trading_account_id, stable_trade_key),
  KEY idx_manual_candidate_list (user_id, trading_account_id, closed_at_utc DESC, id),
  CONSTRAINT fk_manual_candidate_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_manual_candidate_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT chk_manual_candidate_period CHECK (closed_at_utc >= opened_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_memory_libraries_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  owner_user_id INT NULL,
  mode ENUM('off','shadow','active') NOT NULL DEFAULT 'shadow',
  status ENUM('active','revalidating','retired') NOT NULL DEFAULT 'active',
  current_revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  max_context_tokens INT UNSIGNED NOT NULL DEFAULT 800,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_memory_strategy (strategy_id),
  UNIQUE KEY uk_strategy_memory_legacy (legacy_source_table, legacy_id),
  KEY idx_strategy_memory_owner (owner_user_id, updated_at_utc, id),
  CONSTRAINT fk_strategy_memory_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_strategy_memory_owner FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_memory_library_revisions_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  library_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  content_text MEDIUMTEXT NOT NULL,
  content_json JSON NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_kind ENUM('bootstrap','review_merge','manual_edit','compression','migration','revoke') NOT NULL,
  source_metadata_json JSON NOT NULL,
  created_by_user_id INT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_memory_revision_identity (id, library_id),
  UNIQUE KEY uk_strategy_memory_revision_number (library_id, version_number),
  CONSTRAINT fk_strategy_memory_revision_library FOREIGN KEY (library_id) REFERENCES strategy_memory_libraries_v4 (id),
  CONSTRAINT fk_strategy_memory_revision_actor FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE strategy_memory_libraries_v4
  ADD CONSTRAINT fk_strategy_memory_current_revision FOREIGN KEY (current_revision_id, id) REFERENCES strategy_memory_library_revisions_v4 (id, library_id);

CREATE TABLE IF NOT EXISTS strategy_memory_pending_updates_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  library_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_review_case_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_review_version_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  update_kind ENUM('short_term','long_term_candidate','monthly_summary','platform_candidate') NOT NULL,
  proposal_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('collecting_evidence','awaiting_confirmation','accepted','rejected','merged','superseded') NOT NULL,
  expected_library_revision BIGINT UNSIGNED NOT NULL,
  proposal_json JSON NOT NULL,
  diff_preview_text MEDIUMTEXT NOT NULL,
  conflict_json JSON NOT NULL,
  decided_by_user_id INT NULL,
  decided_at_utc DATETIME(3) NULL,
  merged_revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_memory_review_update (library_id, source_review_version_id, update_kind, proposal_key),
  KEY idx_strategy_memory_proposal_support (library_id, update_kind, proposal_key, status, source_review_case_id),
  KEY idx_strategy_memory_pending (library_id, status, created_at_utc, id),
  CONSTRAINT fk_strategy_memory_update_library FOREIGN KEY (library_id) REFERENCES strategy_memory_libraries_v4 (id),
  CONSTRAINT fk_strategy_memory_update_case FOREIGN KEY (source_review_case_id) REFERENCES review_cases_v4 (id),
  CONSTRAINT fk_strategy_memory_update_version FOREIGN KEY (source_review_version_id, source_review_case_id) REFERENCES review_versions_v4 (id, review_case_id),
  CONSTRAINT fk_strategy_memory_update_actor FOREIGN KEY (decided_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_strategy_memory_update_merged_revision FOREIGN KEY (merged_revision_id, library_id) REFERENCES strategy_memory_library_revisions_v4 (id, library_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_memory_injection_logs_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  library_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  library_revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  runtime_kind ENUM('analysis','review','memory_compression') NOT NULL,
  runtime_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  injected TINYINT(1) NOT NULL,
  matched_context_json JSON NOT NULL,
  token_count INT UNSIGNED NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_memory_injection (runtime_kind, runtime_id, library_revision_id),
  KEY idx_strategy_memory_injection_strategy (strategy_id, occurred_at_utc, id),
  CONSTRAINT fk_strategy_memory_injection_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_strategy_memory_injection_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_strategy_memory_injection_library FOREIGN KEY (library_id) REFERENCES strategy_memory_libraries_v4 (id),
  CONSTRAINT fk_strategy_memory_injection_revision FOREIGN KEY (library_revision_id, library_id) REFERENCES strategy_memory_library_revisions_v4 (id, library_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Release migration mapping (never performed by application startup):
-- 1. period_review_* and manual_trade_review_* map into review_cases_v4 while
--    preserving legacy_source_table/legacy_id and immutable version hashes.
-- 2. trade_review_cases become direct/counterexample/false-positive sources;
--    missed opportunities remain candidates until deterministic evidence proves them.
-- 3. strategy_memory_* and platform experience rows merge by strategy_id into one
--    library. Only human-confirmed versions may create pending updates.
-- 4. Every batch is checkpointed, reconciled per user and strategy, and reversible;
--    source tables are retained until the final separately-authorized cutover cleanup.
