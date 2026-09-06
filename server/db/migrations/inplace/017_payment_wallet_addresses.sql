CREATE TABLE payment_wallet_addresses (
  id INT NOT NULL AUTO_INCREMENT,
  chain VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  address_index INT NOT NULL,
  address VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NULL,
  custody_reference VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  custody_evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  custody_verified_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_payment_wallet_chain_index (chain, address_index),
  UNIQUE KEY uk_payment_wallet_chain_address (chain, address),
  CONSTRAINT fk_payment_wallet_migration_run FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs(id),
  CONSTRAINT chk_payment_wallet_chain CHECK (chain IN ('TRON', 'ETH', 'BSC', 'SOL')
    AND OCTET_LENGTH(chain) = CASE chain WHEN 'TRON' THEN 4 ELSE 3 END),
  CONSTRAINT chk_payment_wallet_index CHECK (address_index >= 0),
  CONSTRAINT chk_payment_wallet_address CHECK (CHAR_LENGTH(address) > 0 AND OCTET_LENGTH(address) = OCTET_LENGTH(TRIM(address))),
  CONSTRAINT chk_payment_wallet_revision CHECK (revision > 0),
  CONSTRAINT chk_payment_wallet_custody CHECK (
    (custody_reference IS NULL AND custody_evidence_sha256 IS NULL AND custody_verified_at_utc IS NULL)
    OR (custody_reference IS NOT NULL AND CHAR_LENGTH(TRIM(custody_reference)) > 0
      AND custody_evidence_sha256 IS NOT NULL AND custody_verified_at_utc IS NOT NULL)
  ),
  CONSTRAINT chk_payment_wallet_hashes CHECK (
    (custody_evidence_sha256 IS NULL OR REGEXP_LIKE(custody_evidence_sha256, '^[0-9a-f]{64}$', 'c'))
    AND (source_sha256 IS NULL OR REGEXP_LIKE(source_sha256, '^[0-9a-f]{64}$', 'c'))
  ),
  CONSTRAINT chk_payment_wallet_origin CHECK (
    (origin = 'native' AND created_at_utc IS NOT NULL AND migration_run_id IS NULL AND source_sha256 IS NULL AND imported_at_utc IS NULL)
    OR (origin = 'legacy_import' AND migration_run_id IS NOT NULL AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
