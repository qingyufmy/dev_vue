CREATE TABLE partial_close_parent_dispatches_v4 (
  parent_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_revision INT UNSIGNED NOT NULL,
  review_json JSON NOT NULL,
  review_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checked_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (parent_command_id),
  CONSTRAINT ck_partial_close_dispatch_revision CHECK (command_revision=2),
  CONSTRAINT fk_partial_close_dispatch_workflow FOREIGN KEY (parent_command_id)
    REFERENCES partial_close_workflows_v4 (parent_command_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
