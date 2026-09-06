ALTER TABLE system_settings
  ADD CONSTRAINT chk_system_setting_exact_tokens CHECK (
    NOT REGEXP_LIKE(namespace, '[^a-z0-9_]', 'c')
    AND NOT REGEXP_LIKE(setting_key, '[^a-z0-9_]', 'c')
    AND NOT REGEXP_LIKE(value_type, '[^a-z_]', 'c')
    AND NOT REGEXP_LIKE(sensitivity, '[^a-z]', 'c')
  ),
  ADD CONSTRAINT chk_system_setting_exact_boolean CHECK (
    value_type <> 'boolean' OR value_text IS NULL OR BINARY value_text IN (BINARY 'true', BINARY 'false')
  ),
  ADD CONSTRAINT chk_system_setting_exact_integer CHECK (
    value_type <> 'integer' OR value_text IS NULL OR NOT REGEXP_LIKE(value_text, '[^0-9-]', 'c')
  );
