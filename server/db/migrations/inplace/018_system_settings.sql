CREATE TABLE system_settings (
  id INT NOT NULL AUTO_INCREMENT,
  namespace VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  setting_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  value_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  value_text MEDIUMTEXT NULL,
  sensitivity VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(255) NULL,
  sort_order INT NULL,
  created_at_utc DATETIME(3) NULL,
  updated_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_system_setting_name (namespace, setting_key),
  CONSTRAINT fk_system_setting_run FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs(id),
  CONSTRAINT chk_system_setting_identity CHECK (
    REGEXP_LIKE(namespace, '^[a-z][a-z0-9_]{0,99}$', 'c') AND REGEXP_LIKE(setting_key, '^[a-z][a-z0-9_]{0,99}$', 'c')),
  CONSTRAINT chk_system_setting_type CHECK (REGEXP_LIKE(value_type, '^(string|boolean|integer|enum|json_array|credential)$', 'c')),
  CONSTRAINT chk_system_setting_sensitivity CHECK (REGEXP_LIKE(sensitivity, '^(public|restricted|secret)$', 'c')
    AND (value_type <> 'credential' OR sensitivity = 'secret')),
  CONSTRAINT chk_system_setting_revision CHECK (revision > 0),
  CONSTRAINT chk_system_setting_boolean CHECK (value_type <> 'boolean' OR value_text IS NULL OR REGEXP_LIKE(value_text, '^(true|false)$', 'c')),
  CONSTRAINT chk_system_setting_integer CHECK (value_type <> 'integer' OR value_text IS NULL OR REGEXP_LIKE(value_text, '^(0|-?[1-9][0-9]*)$', 'c')),
  CONSTRAINT chk_system_setting_array CHECK (value_type <> 'json_array' OR value_text IS NULL OR
    CASE WHEN JSON_VALID(value_text) THEN JSON_TYPE(CAST(value_text AS JSON)) = 'ARRAY' ELSE FALSE END),
  CONSTRAINT chk_system_setting_credential CHECK (value_type <> 'credential' OR value_text IS NULL OR OCTET_LENGTH(value_text) = 0 OR
    CASE WHEN JSON_VALID(value_text) THEN JSON_TYPE(CAST(value_text AS JSON)) = 'OBJECT'
      AND JSON_CONTAINS_PATH(CAST(value_text AS JSON), 'all', '$.v', '$.ct', '$.iv', '$.tag') ELSE FALSE END),
  CONSTRAINT chk_system_setting_hash CHECK (source_sha256 IS NULL OR REGEXP_LIKE(source_sha256, '^[0-9a-f]{64}$', 'c')),
  CONSTRAINT chk_system_setting_origin CHECK (
    (BINARY origin = BINARY 'native' AND created_at_utc IS NOT NULL AND updated_at_utc IS NOT NULL
      AND migration_run_id IS NULL AND source_sha256 IS NULL AND imported_at_utc IS NULL)
    OR (BINARY origin = BINARY 'legacy_import' AND migration_run_id IS NOT NULL AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
