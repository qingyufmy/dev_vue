-- M1 macro feature/model metadata, pipeline jobs and immutable published snapshot lineage.
-- TARGET: empty V4 side-by-side database after 20260905_015. Never run against the legacy source database.

CREATE TABLE IF NOT EXISTS macro_feature_sets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  feature_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  schema_version SMALLINT UNSIGNED NOT NULL,
  definition_json JSON NOT NULL,
  definition_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('draft','active','retired') NOT NULL DEFAULT 'draft',
  created_by_user_id INT NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  activated_at_utc DATETIME(3) NULL,
  retired_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_macro_feature_set_version (feature_key, version_number),
  KEY idx_macro_feature_set_status (status, id),
  CONSTRAINT fk_macro_feature_set_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_macro_feature_set_version CHECK (version_number>0 AND schema_version>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS macro_model_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  model_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  feature_set_id BIGINT UNSIGNED NOT NULL,
  model_kind ENUM('baseline','linear','elastic_net','xgboost','regime') NOT NULL,
  lifecycle_status ENUM('draft','evaluating','shadow','active','rejected','retired') NOT NULL DEFAULT 'draft',
  training_cutoff_at_utc DATETIME(3) NOT NULL,
  config_json JSON NOT NULL,
  input_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  artifact_ref VARCHAR(2048) NOT NULL,
  artifact_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  report_ref VARCHAR(2048) NOT NULL,
  report_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_by_user_id INT NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  activated_at_utc DATETIME(3) NULL,
  retired_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_macro_model_version (model_key, version_number),
  KEY idx_macro_model_lifecycle (lifecycle_status, id),
  CONSTRAINT fk_macro_model_feature_set FOREIGN KEY (feature_set_id) REFERENCES macro_feature_sets (id),
  CONSTRAINT fk_macro_model_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_macro_model_version CHECK (version_number>0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS macro_pipeline_jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  job_kind ENUM('feature_build','model_train','model_evaluate','snapshot_publish','health_refresh') NOT NULL,
  idempotency_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  feature_set_id BIGINT UNSIGNED NULL,
  model_version_id BIGINT UNSIGNED NULL,
  data_cutoff_at_utc DATETIME(3) NULL,
  input_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('queued','running','succeeded','failed','status_unknown','cancelled') NOT NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at_utc DATETIME(3) NULL,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_summary VARCHAR(1000) NULL,
  result_ref VARCHAR(2048) NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  requested_by_user_id INT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_macro_pipeline_job_idempotency (job_kind, idempotency_key),
  KEY idx_macro_pipeline_job_claim (status, lease_expires_at_utc, created_at_utc, id),
  CONSTRAINT fk_macro_pipeline_feature_set FOREIGN KEY (feature_set_id) REFERENCES macro_feature_sets (id),
  CONSTRAINT fk_macro_pipeline_model FOREIGN KEY (model_version_id) REFERENCES macro_model_versions (id),
  CONSTRAINT fk_macro_pipeline_requester FOREIGN KEY (requested_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE macro_research_snapshots
  ADD COLUMN schema_version SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER id,
  ADD COLUMN business_date DATE NULL AFTER schema_version,
  ADD COLUMN data_cutoff_at_utc DATETIME(3) NULL AFTER business_date,
  ADD COLUMN feature_set_id BIGINT UNSIGNED NULL AFTER data_cutoff_at_utc,
  ADD COLUMN model_version_id BIGINT UNSIGNED NULL AFTER feature_set_id,
  ADD COLUMN publication_status ENUM('legacy','draft','published','superseded','invalidated') NOT NULL DEFAULT 'legacy' AFTER revision,
  ADD COLUMN freshness_status ENUM('fresh','stale','partial','unavailable') NOT NULL DEFAULT 'unavailable' AFTER publication_status,
  ADD COLUMN health_status ENUM('healthy','degraded','failed') NOT NULL DEFAULT 'failed' AFTER freshness_status,
  ADD COLUMN horizon VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER health_status,
  ADD COLUMN published_at_utc DATETIME(3) NULL AFTER valid_until_utc,
  ADD COLUMN superseded_at_utc DATETIME(3) NULL AFTER published_at_utc,
  ADD COLUMN active_publication_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN publication_status='published' AND superseded_at_utc IS NULL
        THEN CONCAT(COALESCE(horizon,''),':',COALESCE(CAST(business_date AS CHAR),''))
        ELSE NULL END
    ) STORED,
  ADD UNIQUE KEY uk_macro_snapshot_active_publication (active_publication_key),
  ADD KEY idx_macro_snapshot_latest (publication_status, published_at_utc, id),
  ADD KEY idx_macro_snapshot_feature (feature_set_id, data_cutoff_at_utc, id),
  ADD CONSTRAINT fk_macro_snapshot_feature FOREIGN KEY (feature_set_id) REFERENCES macro_feature_sets (id),
  ADD CONSTRAINT fk_macro_snapshot_model FOREIGN KEY (model_version_id) REFERENCES macro_model_versions (id),
  ADD CONSTRAINT chk_macro_snapshot_platform_v1 CHECK (schema_version=0 OR (owner_scope='platform' AND owner_user_id IS NULL)),
  ADD CONSTRAINT chk_macro_snapshot_publication CHECK (
    publication_status IN ('legacy','draft') OR
    (schema_version>0 AND business_date IS NOT NULL AND data_cutoff_at_utc IS NOT NULL AND feature_set_id IS NOT NULL
      AND horizon IS NOT NULL AND published_at_utc IS NOT NULL)
  ),
  ADD CONSTRAINT chk_macro_snapshot_superseded CHECK (
    (publication_status='superseded' AND superseded_at_utc IS NOT NULL) OR publication_status<>'superseded'
  ),
  ADD CONSTRAINT chk_macro_snapshot_timing CHECK (
    schema_version=0 OR publication_status IN ('legacy','draft') OR
    (data_cutoff_at_utc<=published_at_utc AND published_at_utc<valid_until_utc)
  );

CREATE TABLE IF NOT EXISTS macro_snapshot_observations (
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observation_id BIGINT UNSIGNED NOT NULL,
  factor_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (snapshot_id, observation_id),
  KEY idx_macro_snapshot_observation_reverse (observation_id, snapshot_id),
  KEY idx_macro_snapshot_factor (snapshot_id, factor_code, observation_id),
  CONSTRAINT fk_macro_snapshot_observation_snapshot FOREIGN KEY (snapshot_id) REFERENCES macro_research_snapshots (id),
  CONSTRAINT fk_macro_snapshot_observation_value FOREIGN KEY (observation_id) REFERENCES macro_observations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
